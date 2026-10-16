import { env, runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";
import { Schema } from "effect";
import { CloudflareAccessContent, unwrap, type ToolRes } from "@tempo/protocol";
import { ACCESS_TEXT } from "../../src/do/workspace/cloudflare-access.ts";
import * as deploy from "../../src/server/handlers/deploy.ts";
import type { HandlerCtx } from "../../src/server/run.ts";
import { sqlRows, waitFor } from "./fakes.ts";
import { seedReadyWorkspace } from "./ready-fixture.ts";

const text = (reply: ToolRes) => (reply.ok ? reply.result : `error: ${reply.error.message}`);

describe("Cloudflare access requests (12, Access requests and grants)", { timeout: 30_000 }, () => {
  it("asks the owner for missing permissions, adds an approval to the project's grant and tells the agent", async ({
    expect,
  }) => {
    const w = await seedReadyWorkspace({ credentials: ["claude"] });
    const session = unwrap(await w.stub.createSession({ agent: "claude" }));

    const ask = (params: Schema.Json) =>
      runInDurableObject(w.stub, () =>
        w.tempod.tool({ op: "request_cloudflare_access", sessionId: session.id, params }),
      );

    const reason = "The todo app needs a database.";

    expect(text(await ask({ permissions: ["workers"], reason }))).toBe(ACCESS_TEXT.granted("workers"));
    expect(text(await ask({ permissions: ["workers", "d1"], reason }))).toBe(ACCESS_TEXT.asked("d1"));
    expect(text(await ask({ permissions: ["r2"], reason }))).toBe(`error: ${ACCESS_TEXT.waiting}`);
    expect(unwrap(await w.stub.getWorkspace({})).attention).toBe("needs_input");

    const card = async () => {
      const [row] = await sqlRows(
        w.stub,
        "SELECT status, content_json FROM items WHERE kind = 'cloudflare_access'",
      );

      return {
        status: row?.["status"],
        content: Schema.decodeUnknownSync(CloudflareAccessContent)(JSON.parse(String(row?.["content_json"]))),
      };
    };

    const pending = await card();
    expect(pending).toMatchObject({
      status: "pending",
      content: { permissions: ["d1"], reason, status: "pending" },
    });

    unwrap(await w.stub.decideCloudflareAccess({ requestId: pending.content.requestId, approve: true }));
    unwrap(await w.stub.decideCloudflareAccess({ requestId: pending.content.requestId, approve: false }));
    expect(await card()).toMatchObject({ status: "completed", content: { status: "approved" } });
    expect(
      unwrap(await env.APP_DEPLOY.getByName(w.seeded.projectId).listGrants()).map((g) => g.permission),
    ).toEqual(["workers", "d1"]);
    await waitFor(async () =>
      (await sqlRows(w.stub, "SELECT content_json FROM items WHERE kind = 'user_message'")).some(
        (r) => JSON.parse(String(r["content_json"])).text === ACCESS_TEXT.approved("d1"),
      ),
    );
    expect(text(await ask({ permissions: ["d1"], reason }))).toBe(ACCESS_TEXT.granted("d1"));

    expect(text(await ask({ permissions: ["r2"], reason }))).toBe(ACCESS_TEXT.asked("r2"));

    const [denied] = await sqlRows(
      w.stub,
      "SELECT id FROM cloudflare_access_requests WHERE status = 'pending'",
    );

    unwrap(await w.stub.decideCloudflareAccess({ requestId: String(denied!["id"]), approve: false }));
    expect(
      unwrap(await env.APP_DEPLOY.getByName(w.seeded.projectId).listGrants()).map((g) => g.permission),
    ).toEqual(["workers", "d1"]);
  });

  it("lists the grant with workers first and lets the owner remove a permission, but never workers", async ({
    expect,
  }) => {
    const w = await seedReadyWorkspace();

    const ctx: HandlerCtx = {
      env,
      user: { id: w.seeded.userId, name: "Owner", email: "o@example.com", image: null },
    };

    const projectId = w.seeded.projectId;
    await env.DB.prepare(
      "UPDATE projects SET provider='artifacts',installation_id=NULL,repo_id=NULL,artifact_repo_id='repo-grants',clone_url='https://x.artifacts.cloudflare.net/git/r/grants.git' WHERE id=?",
    )
      .bind(projectId)
      .run();
    unwrap(
      await env.APP_DEPLOY.getByName(projectId).grant({
        permissions: ["routes", "d1"],
        workspaceId: w.workspaceId,
        requestId: "req-1",
      }),
    );

    expect((await deploy.listCloudflareGrants(ctx, { projectId })).map((g) => g.permission)).toEqual([
      "workers",
      "d1",
      "routes",
    ]);
    expect(
      (await deploy.removeCloudflareGrant(ctx, { projectId, permission: "routes" })).map((g) => g.permission),
    ).toEqual(["workers", "d1"]);
    await expect(
      deploy.removeCloudflareGrant(ctx, { projectId, permission: "workers" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});
