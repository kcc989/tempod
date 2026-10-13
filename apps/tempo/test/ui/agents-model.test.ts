import { describe, expect, it } from "vitest";
import {
  addTags,
  emptyForm,
  emptyServer,
  formFromAgent,
  validateForm,
} from "../../src/ui/components/dialogs/settings/agents-model";
import { customAgentMenu, sessionTitle, sessionTooltip } from "../../src/ui/components/chat/chat-tabs-model";
import { profileIssuesText } from "../../src/ui/components/chat/composer-model";
import {
  customAgentOf,
  createInput,
  customAgentValue,
  customAgentsWithLogin,
  emptySource,
} from "../../src/ui/components/dialogs/new-workspace-model";

const creds = (set: string[]) =>
  Object.fromEntries(
    ["claude", "codex", "openrouter", "anthropic", "openai"].map((p) => [
      p,
      { set: set.includes(p), updatedAt: null },
    ]),
  ) as never;

describe("agent form (04, Settings → Agents)", () => {
  it("builds a definition with trimmed values and env refs", () => {
    const server = { ...emptyServer(), name: "docs", command: "docs-mcp", vars: "TOKEN=${DOCS_TOKEN}\n\n" };
    const { errors, definition } = validateForm({
      ...emptyForm(),
      name: " Tester ",
      model: " opus ",
      servers: [server],
    });
    expect(errors).toEqual({});
    expect(definition).toMatchObject({
      name: "Tester",
      model: "opus",
      mcp: {
        servers: [
          { name: "docs", type: "stdio", command: "docs-mcp", args: [], env: { TOKEN: "${DOCS_TOKEN}" } },
        ],
      },
    });
  });

  it("reports field errors for names, URLs, literal values and tool names", () => {
    const a = { ...emptyServer(), name: "playwright", type: "http" as const, url: "http://x" };
    const b = { ...emptyServer(), name: "Bad Name", command: "x", vars: "K=literal" };
    const { errors, definition } = validateForm({
      ...emptyForm(),
      name: "",
      allow: ["a,b"],
      servers: [a, b],
    });
    expect(definition).toBeNull();
    expect(errors["name"]).toBe("Enter a name.");
    expect(errors["allow"]).toBe("Not a valid tool name: a,b");
    expect(errors[`server.${a.key}.name`]).toMatch(/reserved/);
    expect(errors[`server.${a.key}.url`]).toBe("Enter an https:// URL.");
    expect(errors[`server.${b.key}.name`]).toMatch(/a-z/);
    expect(errors[`server.${b.key}.vars`]).toMatch(/K: use/);
  });

  it("round-trips a saved agent into the form", () => {
    const form = formFromAgent({
      id: "x",
      commitSha: "c",
      updatedAt: 1,
      name: "R",
      description: "",
      baseAgent: "pi",
      model: "",
      thoughtLevel: "",
      systemPrompt: "",
      tools: { allow: ["read"], deny: [] },
      mcp: {
        playwright: true,
        servers: [{ name: "s", type: "http", url: "https://x.dev", headers: { A: "${B}" } }],
      },
    });
    expect(form.servers[0]).toMatchObject({ name: "s", type: "http", url: "https://x.dev", vars: "A=${B}" });
    expect(validateForm(form).definition?.mcp.servers[0]).toEqual({
      name: "s",
      type: "http",
      url: "https://x.dev",
      headers: { A: "${B}" },
    });
  });

  it("adds tags once, split on commas and spaces", () => {
    expect(addTags(["Edit"], "Write, Edit  Bash")).toEqual(["Edit", "Write", "Bash"]);
  });
});

describe("custom agents in New chat and New workspace (04)", () => {
  const agents = [
    { id: "a1", name: "Reviewer", description: "", baseAgent: "codex" as const, updatedAt: 1 },
    { id: "a2", name: "Pi tester", description: "", baseAgent: "pi" as const, updatedAt: 1 },
  ];

  it("menu entries name the base agent and hide agents without its login", () => {
    expect(customAgentMenu(agents, creds(["codex"]))).toEqual([
      {
        agent: "codex",
        customAgentId: "a1",
        label: "Reviewer",
        baseLabel: "Codex",
        enabled: true,
        hint: null,
      },
    ]);
    expect(customAgentMenu(undefined, undefined)).toEqual([]);
    expect(customAgentMenu(agents, undefined)).toEqual([]);
    expect(customAgentMenu(agents, creds([]))).toEqual([]);
  });

  it("the New workspace select maps custom values back to the agent and sends customAgentId", () => {
    const custom = customAgentsWithLogin(agents, ["claude", "codex"]);
    expect(custom.map((a) => a.id)).toEqual(["a1"]);
    expect(customAgentOf(customAgentValue("a1"), custom)?.baseAgent).toBe("codex");
    expect(customAgentOf(customAgentValue("a2"), custom)).toBeNull();
    expect(customAgentOf('["claude","opus"]', custom)).toBeNull();
    expect(
      createInput({ id: "p", defaultBranch: "main" }, emptySource(), "codex", "", undefined, "a1"),
    ).toEqual({
      projectId: "p",
      source: { kind: "new", baseBranch: "main" },
      agent: "codex",
      customAgentId: "a1",
    });
  });

  it("tabs show the custom agent's name and the base agent in the tooltip", () => {
    const s = {
      title: "",
      agent: "codex" as const,
      customAgent: { id: "a1", name: "Reviewer", commitSha: "c" },
    };
    expect(sessionTitle(s)).toBe("Reviewer");
    expect(sessionTooltip(s)).toBe("Reviewer · Codex");
    expect(sessionTooltip({ agent: "codex" })).toBeNull();
  });

  it("the notice lists what the base agent ignored", () => {
    const s = {
      agent: "codex" as const,
      customAgent: { id: "a1", name: "Reviewer", commitSha: "c" },
      profileIssues: ["tools", "thoughtLevel"] as const,
    };
    expect(profileIssuesText(s)).toBe(
      "Codex ignored some settings of Reviewer: tool limits, reasoning level",
    );
    expect(profileIssuesText({ ...s, profileIssues: [] })).toBeNull();
    expect(profileIssuesText({ agent: "codex", profileIssues: ["tools"] })).toBeNull();
  });
});
