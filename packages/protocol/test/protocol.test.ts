import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  API,
  ERROR_CODES,
  ERROR_MESSAGES,
  FN_NAMES,
  Item,
  TEMPOD_REQUESTS,
  TempodEvent,
  TempoError,
  WORKSPACE_FNS,
  WorkspaceServerMessage,
  capture,
  errorMessage,
  newId,
  newPreviewToken,
  randomToken,
  reconnectDelay,
  redact,
  revertNote,
  toErrorBody,
  unwrap,
  ULID_PATTERN,
} from "../src/index.ts";

describe("ids", () => {
  it("makes lowercase, monotonic ULIDs (02, IDs)", () => {
    const ids = Array.from({ length: 100 }, () => newId());
    for (const id of ids) expect(id).toMatch(ULID_PATTERN);
    expect([...ids].sort()).toEqual(ids);
  });
  it("makes 16-char [a-z0-9] preview tokens (01, Preview URL)", () => {
    expect(newPreviewToken()).toMatch(/^[a-z0-9]{16}$/);
    expect(randomToken(32)).toHaveLength(32);
  });
});

describe("errors", () => {
  it("has one message per code, and agent names fill <agent>", () => {
    expect(ERROR_CODES).toHaveLength(Object.keys(ERROR_MESSAGES).length);
    expect(errorMessage("CREDENTIAL_MISSING", "codex")).toBe("Add your Codex login in Settings.");
    expect(errorMessage("NOT_FOUND")).toBe("Not found.");
  });
  it("round-trips TempoError through the Result envelope", async () => {
    const res = await capture(() => {
      throw new TempoError("PUSH_REJECTED", undefined, "remote said no");
    });
    expect(res).toEqual({
      ok: false,
      error: { code: "PUSH_REJECTED", message: ERROR_MESSAGES.PUSH_REJECTED, detail: "remote said no" },
    });
    expect(() => unwrap(res)).toThrowError(TempoError);
    expect(toErrorBody(new Error("secret token sk-1"))).toEqual({
      code: "INTERNAL",
      message: "Something went wrong.",
    });
  });
});

describe("contract", () => {
  it("lists every function with a method", () => {
    expect(FN_NAMES.length).toBeGreaterThan(50);
    for (const name of FN_NAMES) expect(["GET", "POST"]).toContain(API[name].method);
  });
  it("routes exactly the functions that take workspaceId to the WorkspaceDO", () => {
    expect(WORKSPACE_FNS).toContain("sendPrompt");
    expect(WORKSPACE_FNS).not.toContain("createWorkspace");
    expect(WORKSPACE_FNS).not.toContain("listWorkspaces");
  });
  it("validates sendPrompt input", () => {
    const decode = Schema.decodeUnknownSync(API.sendPrompt.input);
    expect(() => decode({ workspaceId: "w", sessionId: "s", text: "hi" })).toThrow();
    expect(
      decode({
        workspaceId: "w",
        sessionId: "s",
        text: "hi",
        mentions: [],
        attachmentIds: [],
        reviewCommentIds: [],
      }).text,
    ).toBe("hi");
  });
  it("checks setClaudeToken: no spaces, 20 to 4096 chars (02, Credentials)", () => {
    const decode = Schema.decodeUnknownExit(API.setClaudeToken.input);
    expect(decode({ token: "short" })._tag).toBe("Failure");
    expect(decode({ token: "has space ".repeat(5) })._tag).toBe("Failure");
    expect(decode({ token: "x".repeat(20) })._tag).toBe("Success");
  });
  it("has the 02 timeout for every tempod op", () => {
    expect(TEMPOD_REQUESTS["repo.clone"].timeoutMs).toBe(600_000);
    expect(TEMPOD_REQUESTS["session.start"].timeoutMs).toBe(120_000);
    expect(TEMPOD_REQUESTS.shutdown.timeoutMs).toBe(45_000);
    expect(Object.keys(TEMPOD_REQUESTS).sort()).toEqual(
      [
        "repo.clone",
        "repo.applyCheckpoint",
        "settings.read",
        "env.set",
        "script.start",
        "script.stop",
        "session.start",
        "session.prompt",
        "session.steer",
        "session.cancel",
        "session.setMode",
        "session.setConfig",
        "session.close",
        "permission.respond",
        "credential.put",
        "git.changes",
        "git.fileDiff",
        "git.checkpoint",
        "git.revert",
        "git.commitAndPush",
        "git.renameBranch",
        "fs.list",
        "fs.read",
        "fs.search",
        "terminal.list",
        "shutdown",
      ].sort(),
    );
  });
});

describe("wire messages", () => {
  it("decodes items by kind", () => {
    const item = Schema.decodeUnknownSync(Item)({
      id: "i",
      sessionId: "s",
      turnId: "t",
      kind: "plan",
      status: "completed",
      content: { entries: [{ content: "a", priority: "high", status: "pending" }] },
      rev: 3,
      createdAt: 1,
      updatedAt: 2,
    });
    expect(item.kind).toBe("plan");
  });
  it("decodes tempod events and channel messages", () => {
    expect(Schema.decodeUnknownSync(TempodEvent)({ kind: "ports.changed", ports: [3000] })).toEqual({
      kind: "ports.changed",
      ports: [3000],
    });
    expect(Schema.decodeUnknownSync(WorkspaceServerMessage)({ type: "pong" })).toEqual({ type: "pong" });
    expect(Schema.decodeUnknownExit(TempodEvent)({ kind: "nope" })._tag).toBe("Failure");
  });
});

describe("helpers", () => {
  it("redacts secret-looking fields (05, Secrets)", () => {
    expect(
      redact({ token: "a", nested: { apiKey: "b", Authorization: "c", ok: 1 }, list: [{ cookie: "d" }] }),
    ).toEqual({
      token: "[redacted]",
      nested: { apiKey: "[redacted]", Authorization: "[redacted]", ok: 1 },
      list: [{ cookie: "[redacted]" }],
    });
  });
  it("backs off 0.5 s doubling to 10 s with 20% jitter (02, reconnect)", () => {
    expect(reconnectDelay(0, () => 0.5)).toBe(500);
    expect(reconnectDelay(10, () => 0.5)).toBe(10_000);
    expect(reconnectDelay(0, () => 1)).toBe(600);
    expect(reconnectDelay(0, () => 0)).toBe(400);
  });
  it("writes the revert note exactly (03, Revert)", () => {
    expect(revertNote(3)).toBe(
      "Note: the user reverted the files to the state after turn 3. Changes made after that point are gone.",
    );
  });
});
