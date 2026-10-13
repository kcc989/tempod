import { createApiClient } from "../../../src/ui/lib/api-client";
import type { Environment, EnvironmentProposal, FnName } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import {
  applyEnvironmentProposal,
  deleteEnvironmentConfirm,
  effectiveEnvironment,
  emptyInjectorRow,
  emptySecretRow,
  findEnvironment,
  formFromEnvironment,
  formSignature,
  parseHosts,
  projectDefaultLabel,
  proposalSecrets,
  proposalTargetText,
  secretHint,
  uniqueEnvironmentName,
  updateFromForm,
} from "~/ui/components/dialogs/environments-model";

const env = (over: Partial<Environment> = {}): Environment => ({
  id: "e1",
  name: "staging",
  egressPolicy: "allowlist",
  egressAllowlist: ["api.example.com"],
  secrets: [
    { name: "STRIPE_KEY", hosts: ["api.stripe.com"], set: true },
    { name: "PLAIN", hosts: [], set: false },
  ],
  injectors: [{ name: "sign", hosts: ["*.amazonaws.com"], code: "export default {}", sha256: "ab" }],
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

describe("environment form", () => {
  it("round-trips an environment without values", () => {
    const form = formFromEnvironment(env());
    expect(form.allowlist).toBe("api.example.com");
    expect(form.secrets.map((s) => [s.name, s.hosts, s.set, s.value, s.isNew])).toEqual([
      ["STRIPE_KEY", "api.stripe.com", true, "", false],
      ["PLAIN", "", false, "", false],
    ]);
    const r = updateFromForm(form);
    expect(r).toEqual({
      ok: true,
      update: {
        name: "staging",
        egressPolicy: "allowlist",
        egressAllowlist: ["api.example.com"],
        secrets: [
          { name: "STRIPE_KEY", hosts: ["api.stripe.com"] },
          { name: "PLAIN", hosts: [] },
        ],
        injectors: [{ name: "sign", hosts: ["*.amazonaws.com"], code: "export default {}" }],
      },
      values: [],
    });
  });

  it("sends only filled value fields", () => {
    const form = formFromEnvironment(env());

    const secrets = [
      { ...form.secrets[0]!, value: "sk_live" },
      form.secrets[1]!,
      { ...emptySecretRow(), name: "NEW_ONE", hosts: "A.example.com, b.example.com", value: "v" },
    ];

    const r = updateFromForm({ ...form, secrets });
    expect(r.ok && r.values).toEqual([
      { name: "STRIPE_KEY", value: "sk_live" },
      { name: "NEW_ONE", value: "v" },
    ]);
    expect(r.ok && r.update.secrets[2]).toEqual({
      name: "NEW_ONE",
      hosts: ["a.example.com", "b.example.com"],
    });
  });

  it("rejects bad names, host patterns and duplicates", () => {
    const form = formFromEnvironment(env());

    const bad = updateFromForm({
      ...form,
      name: "  ",
      allowlist: "ok.example.com\nhttp://nope",
      secrets: [...form.secrets, { ...emptySecretRow(), name: "STRIPE_KEY" }],
      injectors: [{ ...emptyInjectorRow(), name: "Bad Name", hosts: "x.com", code: "x" }],
    });

    expect(bad.ok).toBe(false);

    if (bad.ok) return;
    expect(bad.errors.name).toBeDefined();
    expect(bad.errors.allowlist).toBe("Not a host pattern: http://nope");
    expect(bad.errors.secrets).toBe("Two secrets are named STRIPE_KEY.");
    expect(bad.errors.injectors).toMatch(/^Bad Name:/);

    const noHosts = updateFromForm({
      ...form,
      injectors: [{ ...emptyInjectorRow(), name: "sign", hosts: "", code: "x" }],
    });

    expect(!noHosts.ok && noHosts.errors.injectors).toBe("sign: use 1 to 20 hosts.");

    const noCode = updateFromForm({
      ...form,
      injectors: [{ ...emptyInjectorRow(), name: "sign", hosts: "x.com", code: "  " }],
    });

    expect(!noCode.ok && noCode.errors.injectors).toBe("sign: add the code.");
  });

  it("ignores row keys when telling whether the form changed", () => {
    expect(formSignature(formFromEnvironment(env()))).toBe(formSignature(formFromEnvironment(env())));
  });

  it("parses hosts from lines or commas", () => {
    expect(parseHosts(" A.com,\n\n*.b.com , ")).toEqual(["a.com", "*.b.com"]);
  });
});

describe("environment copy", () => {
  it("warns about secrets with no hosts and explains swapped ones", () => {
    expect(secretHint("KEY", "")).toEqual({ tone: "warning", text: "Visible to the agent" });
    expect(secretHint("KEY", "a.com, *.b.com")).toEqual({
      tone: "muted",
      text: "Use $KEY in the app; Tempo adds the value for a.com, *.b.com",
    });
  });
  it("uses the 04 delete confirmation", () => {
    const c = deleteEnvironmentConfirm("staging");
    expect(`${c.title} ${c.description}`).toBe(
      "Delete environment staging? Projects that use it will use none.",
    );
    expect(c.destructive).toBe(true);
  });
  it("names the project default", () => {
    expect(projectDefaultLabel(null)).toBe("Project default (None)");
    expect(projectDefaultLabel(env())).toBe("Project default (staging)");
  });
});

describe("which environment applies", () => {
  const envs = [env(), env({ id: "e2", name: "prod" })];
  it("prefers the workspace override, then the project's, and treats missing ids as none", () => {
    expect(effectiveEnvironment(envs, "e2", { environmentId: "e1" })?.id).toBe("e2");
    expect(effectiveEnvironment(envs, null, { environmentId: "e1" })?.id).toBe("e1");
    expect(effectiveEnvironment(envs, undefined, { environmentId: null })).toBeNull();
    expect(effectiveEnvironment(envs, null, { environmentId: "gone" })).toBeNull();
    expect(findEnvironment(envs, null)).toBeNull();
  });
  it("picks a free name", () => {
    expect(uniqueEnvironmentName("web", [])).toBe("web");
    expect(uniqueEnvironmentName("web", ["web", "web 2"])).toBe("web 3");
    expect(uniqueEnvironmentName("x".repeat(70), ["x".repeat(64)])).toBe(`${"x".repeat(62)} 2`);
  });
});

describe("proposals", () => {
  const proposal: EnvironmentProposal = {
    note: "Needs Stripe",
    egressPolicy: "open",
    allowlistAdd: ["api.stripe.com"],
    secrets: [
      { name: "STRIPE_KEY", hosts: ["api.stripe.com"] },
      { name: "PLAIN", hosts: [] },
      { name: "NEW", hosts: [] },
    ],
  };

  it("asks for values of new and unset secrets only", () => {
    expect(proposalSecrets(proposal, env()).map((s) => [s.name, s.needsValue])).toEqual([
      ["STRIPE_KEY", false],
      ["PLAIN", true],
      ["NEW", true],
    ]);
    expect(proposalSecrets(proposal, null).every((s) => s.needsValue)).toBe(true);
  });

  it("names the target", () => {
    expect(proposalTargetText(env(), "web")).toBe("Apply to staging");
    expect(proposalTargetText(null, "web")).toBe("Create environment web and use it for this project");
  });

  const fake = () => {
    const calls: Array<[FnName, unknown]> = [];
    const created = env({ id: "new", name: "web 2", egressAllowlist: [], secrets: [], injectors: [] });

    const caller = createApiClient(async (name, input) => {
      calls.push([name, input]);

      if (name === "createEnvironment") return JSON.stringify({ ok: true, value: created });

      if (name === "updateEnvironment") return JSON.stringify({ ok: true, value: created });

      if (name === "setProjectEnvironment")
        return JSON.stringify({
          ok: true,
          value: {
            id: "p1",
            installationId: 1,
            repoId: 1,
            owner: "acme",
            name: "web",
            defaultBranch: "main",
            settings: {},
            sortOrder: 0,
            environmentId: created.id,
          },
        });

      return JSON.stringify({ ok: true, value: {} });
    });

    return { calls, caller };
  };

  it("creates an environment for the project when none applies", async () => {
    const { calls, caller } = fake();
    await applyEnvironmentProposal(caller, {
      workspaceId: "w1",
      proposalId: "p9",
      proposal,
      project: { id: "p1", name: "web" },
      target: null,
      environments: [env({ name: "web" })],
      values: { NEW: "secret", PLAIN: "" },
    });
    expect(calls).toEqual([
      ["createEnvironment", { name: "web 2" }],
      ["setProjectEnvironment", { projectId: "p1", environmentId: "new" }],
      [
        "updateEnvironment",
        {
          environmentId: "new",
          egressPolicy: "open",
          egressAllowlist: ["api.stripe.com"],
          secrets: proposal.secrets,
          injectors: [],
        },
      ],
      ["setEnvironmentSecret", { environmentId: "new", name: "NEW", value: "secret" }],
      ["resolveEnvironmentProposal", { workspaceId: "w1", proposalId: "p9", status: "applied" }],
    ]);
  });

  it("updates the effective environment and keeps what it has", async () => {
    const { calls, caller } = fake();
    await applyEnvironmentProposal(caller, {
      workspaceId: "w1",
      proposalId: "p9",
      proposal,
      project: { id: "p1", name: "web" },
      target: env(),
      environments: [env()],
      values: {},
    });
    expect(calls.map((c) => c[0])).toEqual(["updateEnvironment", "resolveEnvironmentProposal"]);
    expect(calls[0]![1]).toMatchObject({
      environmentId: "e1",
      egressAllowlist: ["api.example.com", "api.stripe.com"],
      injectors: [{ name: "sign", hosts: ["*.amazonaws.com"], code: "export default {}" }],
    });
  });

  it("stops before resolving when a step fails", async () => {
    const calls: FnName[] = [];

    const caller = createApiClient(async (name) => {
      calls.push(name);

      if (name === "updateEnvironment") throw new Error("VALIDATION_FAILED");

      return JSON.stringify({ ok: true, value: {} });
    });

    await expect(
      applyEnvironmentProposal(caller, {
        workspaceId: "w1",
        proposalId: "p9",
        proposal,
        project: { id: "p1", name: "web" },
        target: env(),
        environments: [env()],
        values: {},
      }),
    ).rejects.toThrow();
    expect(calls).toEqual(["updateEnvironment"]);
  });
});
