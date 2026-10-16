import { runInDurableObject, env } from "cloudflare:test";
import { describe, it } from "vitest";
import { CapabilityManifest, PLACEHOLDER, unwrap, type CapabilityCall } from "@tempo/protocol";
import { decide, type EgressConfig } from "../../src/egress/rules.ts";
import { ACCESS_REMOVED_NOTICE, removedCapabilities } from "../../src/do/workspace/manifest.ts";
import { Schema } from "effect";
import { sqlRows, waitFor } from "./fakes.ts";
import { seedReadyWorkspace } from "./ready-fixture.ts";

const STRIPE: CapabilityCall = {
  id: "stripe",
  hosts: ["api.stripe.com"],
  credential: { ref: "STRIPE_KEY", placeholder: "tempo-secret-STRIPE_KEY" },
  methods: ["GET", "POST"],
  builtin: false,
};

const config = (calls: ReadonlyArray<CapabilityCall>): EgressConfig => ({
  owner: "acme",
  repo: "app",
  policy: "allowlist",
  allowlist: ["example.com"],
  mcp: [],
  secrets: [{ name: "STRIPE_KEY", hosts: ["api.stripe.com"] }],
  calls,
});

const ask = (
  url: string,
  headers: Record<string, string>,
  calls: ReadonlyArray<CapabilityCall>,
  method = "GET",
) => decide(new URL(url), new Headers(headers), "tempo.test", config(calls), method);

const PROFILE = `version: 1
stack:
  runtime: bun 1.3
services:
  - name: stripe
    purpose: Payments
    hosts: [api.stripe.com]
    credential: STRIPE_KEY
    methods: [GET, POST]
`;

describe("capability manifest (14)", { timeout: 30_000 }, () => {
  it("passes a credential or allowlisted host only with a granted capability, within its methods", ({
    expect,
  }) => {
    const secret = { authorization: "Bearer tempo-secret-STRIPE_KEY" };

    expect(ask("https://api.stripe.com/v1/charges", secret, [STRIPE])).toMatchObject({
      action: "swap",
      capability: "stripe",
    });
    expect(ask("https://api.stripe.com/v1/charges/1", secret, [STRIPE], "delete")).toMatchObject({
      action: "block",
      status: 403,
      body: "tempo: capability stripe not granted for api.stripe.com",
    });
    expect(ask("https://api.stripe.com/v1/charges", secret, [])).toMatchObject({
      body: "tempo: no capability for api.stripe.com",
    });

    const openrouter = { authorization: `Bearer ${PLACEHOLDER}` };
    expect(ask("https://openrouter.ai/api/v1/chat", openrouter, [])).toMatchObject({
      body: "tempo: capability openrouter not granted for openrouter.ai",
    });
    expect(
      ask("https://openrouter.ai/api/v1/chat", openrouter, [
        { id: "openrouter", hosts: ["openrouter.ai"], credential: null, methods: [], builtin: true },
      ]),
    ).toMatchObject({ action: "forward", capability: "openrouter" });

    expect(ask("https://example.com/", {}, [])).toMatchObject({
      body: "tempo: no capability for example.com",
    });
    expect(ask("https://registry.npmjs.org/react", {}, [])).toMatchObject({ action: "forward", rule: 9 });

    const manifest = (calls: ReadonlyArray<CapabilityCall>): CapabilityManifest => ({
      schemaVersion: 1,
      projectId: "p",
      revision: 1,
      sha256: "",
      session: { kind: "chat", access: "write" },
      stack: { runtime: null, packageManager: null, frameworks: [], libraries: [] },
      read: ["repo"],
      call: calls,
      cloudflare: null,
      exceptions: [],
      deploy: [],
    });

    expect(removedCapabilities(manifest([{ ...STRIPE, methods: [] }]), manifest([STRIPE]))).toEqual([]);
    expect(removedCapabilities(manifest([{ ...STRIPE, methods: ["GET"] }]), manifest([STRIPE]))).toEqual([
      "stripe",
    ]);
    expect(removedCapabilities(manifest([]), manifest([STRIPE]))).toEqual(["stripe"]);
  });

  it("freezes a manifest on each session, tells the agent, and ends the session when the owner removes access", async ({
    expect,
  }) => {
    const w = await seedReadyWorkspace({ credentials: ["claude"] });
    const deploy = env.APP_DEPLOY.getByName(w.seeded.projectId);
    unwrap(await deploy.updateProfile({ source: PROFILE, revision: 0 }));
    const session = unwrap(await w.stub.createSession({ agent: "claude" }));

    unwrap(
      await w.stub.sendPrompt({
        sessionId: session.id,
        text: "hi",
        mentions: [],
        attachmentIds: [],
        reviewCommentIds: [],
      }),
    );
    await waitFor(() => w.tempod.requestsOf("session.prompt").length > 0);
    expect(w.tempod.requestsOf("session.prompt")[0].content[0].text).toBe(
      [
        "Capabilities (manifest revision 1). Requests outside them are refused. Call the tempo tool get_capabilities for the full list.",
        "Stack: bun 1.3",
        "Read: repo, issues, pull_requests, ci_runs",
        "Call: stripe (api.stripe.com; GET, POST)",
        "Exceptions: claude_login",
      ].join("\n"),
    );

    const reply = await runInDurableObject(w.stub, () =>
      w.tempod.tool({ op: "get_capabilities", sessionId: session.id, params: {} }),
    );

    expect(reply).toMatchObject({
      ok: true,
      result: { revision: 1, call: [STRIPE], exceptions: ["claude_login"] },
    });
    expect(reply.ok && Schema.is(Schema.Struct({ sha256: Schema.String }))(reply.result)).toBe(false);

    unwrap(await deploy.updateProfile({ source: "version: 1\n", revision: 1 }));
    expect((await w.stub.getEgressConfig()).calls).toEqual([]);
    const [row] = await sqlRows(w.stub, "SELECT status FROM sessions WHERE id = ?", session.id);
    expect(row?.["status"]).toBe("closed");
    const notices = await sqlRows(w.stub, "SELECT content_json FROM items WHERE kind = 'notice'");
    expect(notices.map((n) => JSON.parse(String(n["content_json"])).text)).toContain(
      ACCESS_REMOVED_NOTICE(["stripe"]),
    );
  });
});
