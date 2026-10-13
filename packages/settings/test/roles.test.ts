import { describe, expect, it } from "vitest";
import { parseRoleFile, parseRoleResult, resolveSettings } from "../src/index.ts";
const role = (front: string, body = "Body\n") => `---\ndescription: Job\n${front}\n---\n${body}`;
describe("role files", () => {
  it("uses YAML 1.2, applies defaults and preserves the body", () => {
    const parsed = parseRoleFile("reviewer", role("on:\n  - event: agent.turn.ended"));
    expect(parsed.body).toBe("Body\n");
    expect(parsed.file.agent).toBe("auto");
    expect(parsed.file.access).toBe("read-only");
    expect(parsed.file.limits).toEqual({ rounds: 1, continues: 2, timeout: "20m", tokens: 0 });
    expect(parsed.file.on).toEqual([{ event: "agent.turn.ended" }]);
  });
  it.each([
    "requestable: true\nunknown: x",
    "on:\n  - event: tempo.branch.pushed\n    role: coder",
    "on:\n  - event: role.run.failed\n    status: fail",
    "on:\n  - event: agent.turn.ended\n    status: queued",
    "requestable: true\nlimits:\n  rounds: 11",
    "requestable: true\nlimits:\n  timeout: 121m",
    "requestable: true\nlimits:\n  timeout: 0m",
    "requestable: true\nlimits:\n  continues: -1",
    "requestable: true\nlimits:\n  tokens: 1.5",
    "requestable: true\nlimits: null",
    "requestable: true\nlimits: 3",
    "requestable: true\nlimits: []",
    "requestable: true\ninputs: [result:X]",
    "requestable: true\nrequestable: false",
    "",
  ])("rejects invalid or unknown fields: %s", (front) =>
    expect(() => parseRoleFile("reviewer", role(front))).toThrow(),
  );
  it("rejects names and oversized files", () => {
    expect(() => parseRoleFile("../role", role("requestable: true"))).toThrow();
    expect(() => parseRoleFile("reviewer", role("requestable: true", "é".repeat(33000)))).toThrow();
  });
  it("validates bounded result JSON without echoing its contents", () => {
    expect(parseRoleResult('{"status":"pass","summary":"okay"}').status).toBe("pass");
    for (const invalid of [
      '{"status":"unknown","summary":"secret-value"}',
      JSON.stringify({ status: "done", summary: "x".repeat(4001) }),
      JSON.stringify({
        status: "done",
        summary: "fine",
        findings: Array(201).fill({ path: "a", text: "x", blocking: true }),
      }),
      '{"status":"done","summary":"fine","extra":true}',
    ])
      expect(() => parseRoleResult(invalid)).toThrow("The role's result was not valid.");
  });
  it("merges each roles setting independently", () => {
    expect(
      resolveSettings(
        { roles: { max_chain_depth: 3 } },
        { tempoYaml: "roles:\n  enabled: false\n  max_runs_per_change: 5\n" },
      ).effective.roles,
    ).toEqual({ enabled: false, max_chain_depth: 3, max_runs_per_change: 5, max_tokens_per_change: 0 });
  });
});
