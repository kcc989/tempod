import type { CustomAgentDefinition } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import { parseAgentFile, stringifyAgentFile } from "../src/index.ts";

const def: CustomAgentDefinition = {
  name: "Reviewer",
  description: "Reviews code",
  baseAgent: "claude",
  model: "opus",
  thoughtLevel: "high",
  systemPrompt: "You review code.\nYou do not edit files.\n",
  tools: { allow: [], deny: ["Edit", "Write"] },
  mcp: {
    playwright: true,
    servers: [
      {
        name: "docs",
        type: "stdio",
        command: "docs-mcp",
        args: ["--stdio"],
        env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
      },
      {
        name: "search",
        type: "http",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "${SEARCH_AUTH}" },
      },
    ],
  },
};

describe("custom agent file (01, Custom agents)", () => {
  it("round-trips a definition through YAML with snake_case keys", () => {
    const text = stringifyAgentFile(def);
    expect(text).toContain("base_agent: claude\n");
    expect(text).toContain("thought_level: high\n");
    expect(text).toContain("  servers:\n");
    expect(parseAgentFile(text)).toEqual(def);
  });

  it("reads an empty file as missing required keys", () => {
    expect(() => parseAgentFile("")).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("reads the spec example with defaults for missing optional keys", () => {
    const parsed = parseAgentFile("name: Min\nbase_agent: pi\n");
    expect(parsed).toEqual({
      name: "Min",
      description: "",
      baseAgent: "pi",
      model: "",
      thoughtLevel: "",
      systemPrompt: "",
      tools: { allow: [], deny: [] },
      mcp: { playwright: true, servers: [] },
    });
  });

  it("fails with VALIDATION_FAILED on bad YAML, bad values and literal secrets", () => {
    expect(() => parseAgentFile("name: [")).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => parseAgentFile("name: x\nbase_agent: gpt\n")).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );

    const literal =
      "name: x\nbase_agent: claude\nmcp:\n  servers:\n    - name: a\n      type: stdio\n      command: a\n      env: { K: secret }\n";

    expect(() => parseAgentFile(literal)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});
