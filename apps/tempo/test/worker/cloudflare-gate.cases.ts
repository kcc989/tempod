import { env, runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";
import { Schema } from "effect";
import { PLACEHOLDER, unwrap } from "@tempo/protocol";
import { gateRule, type ProjectResources } from "../../src/deploy/cf-gate.ts";
import { DEPLOY_ACCOUNT_KEY, DEPLOY_MASTER_KEY } from "../../src/deploy/types.ts";
import type { AppDeployDO } from "../../src/do/app-deploy.ts";
import { CF_GATE_TEXT, cloudflareJudge } from "../../src/do/workspace/cloudflare-gate.ts";
import { decide } from "../../src/egress/rules.ts";
import { jevClient, type Judge } from "../../src/judge/jev.ts";
import { sqlRows, waitFor } from "./fakes.ts";
import { seedReadyWorkspace } from "./ready-fixture.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

const API = `/client/v4/accounts/${ACCOUNT}`;

const PROJECT: ProjectResources = {
  accountId: ACCOUNT,
  resources: [
    { id: "worker:todo-web", production: false },
    { id: "d1:db-preview", production: false },
    { id: "worker:todo-prod", production: true },
    { id: "d1:db-prod", production: true },
  ],
};

const CONFIG = [
  "version: 1",
  "tool: alchemy",
  "targets:",
  "  production:",
  "    branch: main",
  "    workers: [todo-prod]",
  "  preview:",
  "    agent: true",
  "    workers: [todo-web]",
].join("\n");

const ok = (result: Schema.Json) => Response.json({ success: true, result });

const BINDINGS = new Map([
  ["todo-web", [{ type: "d1", id: "db-preview", name: "DB" }]],
  ["todo-prod", [{ type: "d1", id: "db-prod", name: "DB" }]],
]);

/** Permission groups, token create and delete, and Worker settings. */
const fakeCloudflare = () => {
  const created: string[] = [];
  const deleted: string[] = [];

  const fetch = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;

    if (path === `${API}/tokens/permission_groups`)
      return ok([
        { id: "g1", name: "Workers Scripts Write", scopes: ["com.cloudflare.api.account"] },
        { id: "g2", name: "Account Settings Read", scopes: ["com.cloudflare.api.account"] },
        { id: "g3", name: "D1 Write", scopes: ["com.cloudflare.api.account"] },
      ]);

    if (request.method === "POST" && path === `${API}/tokens`) {
      created.push(path);

      return ok({ id: `tok-${created.length}`, value: `agent-secret-${created.length}` });
    }

    if (request.method === "DELETE") {
      deleted.push(path.split("/").pop()!);

      return ok({});
    }

    const settings = /\/workers\/scripts\/([^/]+)\/settings$/.exec(path);

    if (settings) return ok({ bindings: BINDINGS.get(settings[1]!) ?? [] });

    return Response.json({ success: false }, { status: 404 });
  };

  return { created, deleted, api: { fetch } };
};

const judgeWith = (aligned: number): Judge =>
  jevClient("test-key", async () =>
    Response.json({
      model: "jev-1.14.0",
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: {
        aligned: { type: "noul", noul: aligned },
        security_risk: { type: "noul", noul: 0.1 },
        hard_rollback: { type: "score", score: 0.2, confidence: 1, legend: {}, probabilities: {} },
      },
    }),
  );

describe("Cloudflare API gate (13, L-ADR-8)", { timeout: 30_000 }, () => {
  it("reads pass, and changes need a project resource that is not production and not on the hold list", ({
    expect,
  }) => {
    expect(gateRule("GET", `${API}/workers/scripts/todo-web/settings`, PROJECT)).toEqual({ action: "allow" });
    expect(gateRule("GET", `${API}/workers/scripts`, PROJECT)).toEqual({ action: "allow" });
    expect(gateRule("GET", `${API}/d1/database/other`, PROJECT)).toEqual({
      action: "hold",
      reasons: ["not_project"],
    });
    expect(gateRule("GET", "/client/v4/accounts/other/workers/scripts", PROJECT)).toMatchObject({
      action: "refuse",
      body: "tempo: Cloudflare account other is not this project's",
    });
    expect(gateRule("POST", `${API}/d1/database/db-preview/query`, PROJECT)).toEqual({
      action: "judge",
      resource: "d1:db-preview",
    });
    expect(gateRule("POST", `${API}/d1/database/db-prod/query`, PROJECT)).toEqual({
      action: "hold",
      reasons: ["production"],
    });
    expect(gateRule("DELETE", `${API}/d1/database/db-preview`, PROJECT)).toEqual({
      action: "hold",
      reasons: ["hold_list"],
    });
    expect(gateRule("POST", `${API}/workers/scripts/todo-web/deployments`, PROJECT)).toEqual({
      action: "hold",
      reasons: ["hold_list"],
    });
    expect(gateRule("POST", "/client/v4/zones/z1/dns_records", PROJECT)).toEqual({
      action: "hold",
      reasons: ["hold_list"],
    });
    expect(gateRule("POST", `${API}/d1/database`, PROJECT)).toEqual({
      action: "hold",
      reasons: ["not_project"],
    });

    const ask = (cloudflare: boolean) =>
      decide(
        new URL(`https://api.cloudflare.com${API}/workers/scripts`),
        new Headers({ authorization: `Bearer ${PLACEHOLDER}` }),
        "tempo.test",
        { owner: "a", repo: "b", policy: "open", allowlist: [], mcp: [], calls: [], cloudflare },
      );

    expect(ask(true)).toMatchObject({ rule: 15, action: "cloudflare", capability: "cloudflare" });
    expect(ask(false)).toMatchObject({ action: "block", body: "tempo: placeholder credential refused" });
  });

  it("judges changes against the confirmed intent, holds the rest for the owner, and allows a held request once", async ({
    expect,
  }) => {
    const w = await seedReadyWorkspace({ credentials: ["claude"] });
    const cloudflare = fakeCloudflare();
    const deploy = env.APP_DEPLOY.getByName(w.seeded.projectId);
    await env.DB.prepare(
      "UPDATE projects SET provider='artifacts',installation_id=NULL,repo_id=NULL,artifact_repo_id='repo-app',clone_url='https://x.artifacts.cloudflare.net/git/r/app.git' WHERE id=?",
    )
      .bind(w.seeded.projectId)
      .run();
    await runInDurableObject(deploy, (instance: AppDeployDO) => {
      instance.cloudflare = cloudflare.api;
    });
    const creds = env.CREDENTIALS.getByName(w.seeded.userId);
    await creds.putSecret(DEPLOY_MASTER_KEY, "master");
    await creds.putSecret(DEPLOY_ACCOUNT_KEY, ACCOUNT);
    unwrap(await deploy.grant({ permissions: ["d1"], workspaceId: w.workspaceId, requestId: "req-test" }));
    unwrap(await deploy.updateConfig({ source: CONFIG, revision: 0 }));
    const aligned = { value: 0.9 };
    await runInDurableObject(w.stub, () => {
      cloudflareJudge.for = async () => judgeWith(aligned.value);
    });

    const session = unwrap(await w.stub.createSession({ agent: "claude" }));
    unwrap(
      await w.stub.sendPrompt({
        sessionId: session.id,
        text: "add due dates",
        mentions: [],
        attachmentIds: [],
        reviewCommentIds: [],
      }),
    );
    await waitFor(() => w.tempod.requestsOf("session.prompt").length > 0);
    const gate = (method: string, path: string) => w.stub.cloudflareGate(method, path);
    const query = `${API}/d1/database/db-preview/query`;

    expect(await gate("POST", query)).toEqual({ allow: false, body: CF_GATE_TEXT.held });
    const [noIntent] = await sqlRows(w.stub, "SELECT reasons_json FROM cloudflare_holds");
    expect(JSON.parse(String(noIntent!["reasons_json"]))).toEqual(["no_intent"]);
    await sqlRows(
      w.stub,
      "UPDATE intents SET status = 'confirmed', goal = 'Add due dates', approach = 'A nullable column'",
    );
    await sqlRows(w.stub, "DELETE FROM cloudflare_holds");

    expect(await gate("POST", query)).toEqual({ allow: true });
    expect(await gate("GET", `${API}/workers/scripts/todo-prod`)).toEqual({ allow: true });
    expect(await gate("POST", `${API}/d1/database/db-prod/query`)).toEqual({
      allow: false,
      body: CF_GATE_TEXT.held,
    });

    aligned.value = 0.1;
    const migrate = `${API}/d1/database/db-preview/import`;
    expect(await gate("POST", migrate)).toEqual({ allow: false, body: CF_GATE_TEXT.held });
    expect(await gate("POST", migrate)).toEqual({ allow: false, body: CF_GATE_TEXT.held });

    const held = await sqlRows(
      w.stub,
      "SELECT id, reasons_json FROM cloudflare_holds WHERE path = ?",
      migrate,
    );

    expect(held.map((h) => JSON.parse(String(h["reasons_json"])))).toEqual([["not_aligned"]]);
    expect(unwrap(await w.stub.getWorkspace({})).attention).toBe("needs_input");

    unwrap(await w.stub.decideCloudflareHold({ holdId: String(held[0]!["id"]), allow: true }));
    expect(await gate("POST", migrate)).toEqual({ allow: true });
    expect(await gate("POST", migrate)).toEqual({ allow: false, body: CF_GATE_TEXT.held });

    const [again] = await sqlRows(
      w.stub,
      "SELECT id FROM cloudflare_holds WHERE path = ? AND status = 'pending'",
      migrate,
    );

    unwrap(await w.stub.decideCloudflareHold({ holdId: String(again!["id"]), allow: false }));
    expect(await gate("POST", migrate)).toEqual({ allow: false, body: CF_GATE_TEXT.refused });

    const cards = await sqlRows(
      w.stub,
      "SELECT status FROM items WHERE kind = 'cloudflare_hold' ORDER BY created_at",
    );

    expect(cards.length).toBe(4);

    expect(await w.stub.getAgentCloudflareToken()).toBe("agent-secret-1");
    expect(await w.stub.getAgentCloudflareToken()).toBe("agent-secret-1");
    expect(cloudflare.created.length).toBe(1);
  });
});
