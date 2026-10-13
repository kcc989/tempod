import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  API,
  CustomAgentDefinition,
  ERROR_MESSAGES,
  TEMPOD_REQUESTS,
  customAgentPath,
  customAgentRepo,
  toAgentProfile,
} from "../src/index.ts";

const base: CustomAgentDefinition = {
  name: "Reviewer",
  description: "",
  baseAgent: "claude",
  model: "",
  thoughtLevel: "",
  systemPrompt: "Review only.",
  tools: { allow: [], deny: ["Edit"] },
  mcp: {
    playwright: true,
    servers: [{ name: "docs", type: "stdio", command: "docs-mcp", args: [], env: { T: "${DOCS_TOKEN}" } }],
  },
};

const valid = Schema.is(CustomAgentDefinition);

describe("custom agent definition (01, Custom agents)", () => {
  it("accepts a full definition", () => {
    expect(valid(base)).toBe(true);
  });

  it("refuses literal env and header values, so no secret reaches Artifacts", () => {
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
    expect(valid({ ...base, name: " padded" })).toBe(false);
    expect(valid({ ...base, name: "x".repeat(61) })).toBe(false);
    expect(valid({ ...base, systemPrompt: "x".repeat(32_001) })).toBe(false);
    expect(valid({ ...base, tools: { allow: ["mcp__docs__*", "read"], deny: [] } })).toBe(true);
    expect(valid({ ...base, tools: { allow: ["a,b"], deny: [] } })).toBe(false);
    expect(
      valid({ ...base, tools: { allow: Array.from({ length: 101 }, (_, i) => `t${i}`), deny: [] } }),
    ).toBe(false);
    const many = Array.from({ length: 11 }, (_, i) => ({ ...base.mcp.servers[0], name: `s${i}` }));
    expect(valid({ ...base, mcp: { ...base.mcp, servers: many } })).toBe(false);
  });

  it("builds the session profile and storage names", () => {
    expect(toAgentProfile(base)).toEqual({
      systemPrompt: "Review only.",
      toolsAllow: [],
      toolsDeny: ["Edit"],
      playwright: true,
      mcpServers: base.mcp.servers,
      thoughtLevel: "",
    });
    expect(customAgentRepo("abc")).toBe("user-abc");
    expect(customAgentPath("01x")).toBe("agents/01x.yaml");
  });

  it("has the functions, codes and session.start fields from 02", () => {
    for (const f of ["listCustomAgents", "getCustomAgent", "saveCustomAgent", "deleteCustomAgent"]) {
      expect(f in API).toBe(true);
    }

    for (const c of ["CUSTOM_AGENT_EXISTS", "CUSTOM_AGENT_LIMIT", "ARTIFACTS_ERROR"])
      expect(c in ERROR_MESSAGES).toBe(true);
    expect("profile" in TEMPOD_REQUESTS["session.start"].params.fields).toBe(true);
  });
});
