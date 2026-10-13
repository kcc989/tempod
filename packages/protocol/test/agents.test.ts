import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AgentDefinition } from "../src/index.ts";

const base: AgentDefinition = {
  handle: "reviewer",
  access: "read-only",
  outputKind: "review",
  name: "Reviewer",
  description: "",
  baseAgent: "claude",
  model: "",
  thoughtLevel: "",
  prompt: "Review only.",
  tools: { allow: [], deny: ["Edit"] },
  mcp: {
    playwright: true,
    servers: [{ name: "docs", type: "stdio", command: "docs-mcp", args: [], env: { T: "${DOCS_TOKEN}" } }],
  },
};

const valid = Schema.is(AgentDefinition);

describe("agent definition (08)", () => {
  it("refuses literal env and header values, so no secret reaches stored definitions", () => {
    expect(valid(base)).toBe(true);
    const env = { ...base.mcp.servers[0], env: { T: "abc123" } };
    expect(valid({ ...base, mcp: { ...base.mcp, servers: [env] } })).toBe(false);
    const headers = { name: "s", type: "http", url: "https://x.dev/mcp", headers: { A: "Bearer ${X}" } };
    expect(valid({ ...base, mcp: { ...base.mcp, servers: [headers] } })).toBe(false);
  });

  it("refuses the reserved name playwright, duplicate names and plain http URLs", () => {
    const pw = { ...base.mcp.servers[0], name: "playwright" };
    expect(valid({ ...base, mcp: { ...base.mcp, servers: [pw] } })).toBe(false);
    const dup = [base.mcp.servers[0], base.mcp.servers[0]];
    expect(valid({ ...base, mcp: { ...base.mcp, servers: dup } })).toBe(false);
    const http = { name: "s", type: "http", url: "http://x.dev/mcp", headers: {} };
    expect(valid({ ...base, mcp: { ...base.mcp, servers: [http] } })).toBe(false);
  });

  it("checks names, limits and tool names", () => {
    expect(valid({ ...base, name: "" })).toBe(false);
    expect(valid({ ...base, handle: "1bad" })).toBe(false);
    expect(valid({ ...base, name: "x".repeat(61) })).toBe(false);
    expect(valid({ ...base, prompt: "x".repeat(32_001) })).toBe(false);
    expect(valid({ ...base, tools: { allow: ["mcp__docs__*", "read"], deny: [] } })).toBe(true);
    expect(valid({ ...base, tools: { allow: ["a,b"], deny: [] } })).toBe(false);
    expect(
      valid({ ...base, tools: { allow: Array.from({ length: 101 }, (_, i) => `t${i}`), deny: [] } }),
    ).toBe(false);
    const many = Array.from({ length: 11 }, (_, i) => ({ ...base.mcp.servers[0], name: `s${i}` }));
    expect(valid({ ...base, mcp: { ...base.mcp, servers: many } })).toBe(false);
  });
});
