import type { Item } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import {
  announceText,
  blockView,
  buildTranscriptRows,
  errorItemMessage,
  fileLinkTarget,
  firstPermissionOption,
  isPermissionAnswered,
  locationLabel,
  messagesToAnnounce,
  planProgress,
  toolContentView,
  toolIcon,
  toUnifiedHunks,
  turnDuration,
  turnOutcome,
  workspacePath,
} from "~/ui/components/chat/transcript-model";
import { diffLines } from "~/ui/lib/diff";
import { agentMessage, turn, userMessage } from "../fixtures";

const map = <T extends { id: string }>(...xs: T[]): Record<string, T> =>
  Object.fromEntries(xs.map((x) => [x.id, x]));

const notice = (id: string, createdAt: number, turnId: string | null = null): Item =>
  ({
    id,
    sessionId: "s1",
    turnId,
    kind: "notice",
    status: "completed",
    content: { level: "info", text: id },
    rev: 1,
    createdAt,
    updatedAt: createdAt,
  }) as Item;

const permission = (over: Partial<Item> & { chosen?: string | null } = {}): Item =>
  ({
    id: "p1",
    sessionId: "s1",
    turnId: "t1",
    kind: "permission",
    status: "pending",
    content: {
      requestId: "r1",
      title: "Run npm test?",
      options: [
        { optionId: "o1", name: "Always", kind: "allow_always" },
        { optionId: "o2", name: "Once", kind: "allow_once" },
        { optionId: "o3", name: "No", kind: "reject_once" },
      ],
      chosenOptionId: over.chosen ?? null,
    },
    rev: 1,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  }) as Item;

describe("transcript rows", () => {
  it("shows items with a footer after each ended turn and a working row for the running one", () => {
    const turns = map(
      turn({ id: "t1", seq: 1, status: "completed", startedAt: 100, endedAt: 900 }),
      turn({ id: "t2", seq: 2, status: "running", startedAt: 1000 }),
    );
    const items = map(
      userMessage("u1", "a", { turnId: "t1", createdAt: 100 }),
      agentMessage("m1", "b", { turnId: "t1", createdAt: 200, status: "completed" }),
      userMessage("u2", "c", { turnId: "t2", createdAt: 1000 }),
      agentMessage("m2", "d", { turnId: "t2", createdAt: 1100 }),
    );
    const rows = buildTranscriptRows(["u1", "m1", "u2", "m2"], items, turns);
    expect(rows.map((r) => r.key)).toEqual(["u1", "m1", "footer:t1", "u2", "m2", "working:t2"]);
  });

  it("leaves out queued and deleted prompts and places a started prompt at its turn's start", () => {
    const turns = map(
      turn({ id: "t1", seq: 1, status: "completed", startedAt: 100, endedAt: 500 }),
      turn({ id: "t2", seq: 2, status: "completed", queuedAt: 150, startedAt: 500, endedAt: 800 }),
      turn({ id: "t3", seq: 3, status: "queued", queuedAt: 160, startedAt: null }),
    );
    const items = map(
      userMessage("u1", "first", { turnId: "t1", createdAt: 100 }),
      userMessage("u2", "waited", { turnId: "t2", createdAt: 150 }),
      userMessage("u3", "queued", { turnId: "t3", createdAt: 160 }),
      userMessage("gone", "deleted", { turnId: "t9", createdAt: 170 }),
      agentMessage("m1", "answer one", { turnId: "t1", createdAt: 200, status: "completed" }),
      agentMessage("m2", "answer two", { turnId: "t2", createdAt: 600, status: "completed" }),
    );
    const rows = buildTranscriptRows(["u1", "u2", "u3", "gone", "m1", "m2"], items, turns);
    expect(rows.map((r) => r.key)).toEqual(["u1", "m1", "footer:t1", "u2", "m2", "footer:t2"]);
  });

  it("dims reverted turns and keeps items without a turn in time order", () => {
    const turns = map(turn({ id: "t1", status: "completed", reverted: true, startedAt: 100, endedAt: 300 }));
    const items = map(
      userMessage("u1", "a", { turnId: "t1", createdAt: 100 }),
      notice("n0", 50),
      notice("n1", 400),
    );
    const rows = buildTranscriptRows(["n0", "u1", "n1"], items, turns);
    expect(rows.map((r) => [r.key, "dim" in r ? r.dim : null])).toEqual([
      ["n0", false],
      ["u1", true],
      ["footer:t1", true],
      ["n1", false],
    ]);
  });
});

describe("announcements", () => {
  it("announces each finished agent message once", () => {
    const seen = new Set<string>();
    const items = map(
      agentMessage("m1", "old", { status: "completed" }),
      agentMessage("m2", "streaming"),
      userMessage("u1", "hi"),
    );
    expect(messagesToAnnounce(seen, ["m1", "m2", "u1"], items)).toEqual(["m1"]);
    const done = { ...items, m2: agentMessage("m2", "streaming done", { status: "completed" }) };
    expect(messagesToAnnounce(seen, ["m1", "m2", "u1"], done)).toEqual(["m2"]);
    expect(messagesToAnnounce(seen, ["m1", "m2", "u1"], done)).toEqual([]);
  });

  it("skips cancelled and empty messages", () => {
    const seen = new Set<string>();
    const items = map(
      agentMessage("m1", "x", { status: "cancelled" }),
      agentMessage("m2", "  ", { status: "completed" }),
    );
    expect(messagesToAnnounce(seen, ["m1", "m2"], items)).toEqual([]);
  });

  it("reads markdown as plain text, cut to a length", () => {
    expect(announceText("**Done.** See [the docs](https://x.y) and `code`.")).toBe(
      "Done. See the docs and code.",
    );
    expect(announceText("```ts\nconst a = 1\n```\nok")).toBe("code block ok");
    expect(announceText("a".repeat(500), 10)).toBe(`${"a".repeat(9)}…`);
  });
});

describe("item helpers", () => {
  it("uses the error table, with the agent's name", () => {
    expect(errorItemMessage("AGENT_CRASHED")).toBe("The agent stopped unexpectedly.");
    expect(errorItemMessage("CREDENTIAL_INVALID", "codex")).toBe(
      "Your Codex login stopped working. Add it again.",
    );
    expect(errorItemMessage("WHAT")).toBe("Something went wrong.");
  });

  it("maps tool kinds to icons", () => {
    expect(toolIcon("execute")).toBe("execute");
    expect(toolIcon("switch_mode")).toBe("switch_mode");
    expect(toolIcon("custom")).toBe("other");
    expect(toolIcon(null)).toBe("other");
  });

  it("turns container paths into repo paths", () => {
    expect(workspacePath("/workspace/src/a.ts")).toBe("src/a.ts");
    expect(workspacePath("src/a.ts")).toBe("src/a.ts");
    expect(workspacePath("/workspace")).toBe("");
    expect(locationLabel({ path: "/workspace/src/a.ts", line: 12 })).toBe("src/a.ts:12");
    expect(locationLabel({ path: "/etc/hosts" })).toBe("/etc/hosts");
  });

  it("reads file links with a line", () => {
    expect(fileLinkTarget("file:///workspace/src/a%20b.ts#L7")).toEqual({ path: "src/a b.ts", line: 7 });
    expect(fileLinkTarget("file:///workspace/README.md")).toEqual({ path: "README.md", line: null });
    expect(fileLinkTarget("https://example.com")).toBeNull();
  });

  it("picks the first allow and the first reject option", () => {
    const p = permission() as Extract<Item, { kind: "permission" }>;
    expect(firstPermissionOption(p.content.options, "allow")?.optionId).toBe("o1");
    expect(firstPermissionOption(p.content.options, "reject")?.optionId).toBe("o3");
    expect(firstPermissionOption([], "allow")).toBeUndefined();
  });

  it("knows when a permission was answered", () => {
    expect(isPermissionAnswered(permission() as Extract<Item, { kind: "permission" }>)).toBe(false);
    expect(isPermissionAnswered(permission({ chosen: "o2" }) as Extract<Item, { kind: "permission" }>)).toBe(
      true,
    );
    expect(
      isPermissionAnswered(permission({ status: "cancelled" }) as Extract<Item, { kind: "permission" }>),
    ).toBe(true);
  });
});

describe("content blocks", () => {
  it("shows inline image data but never loads a remote image", () => {
    expect(blockView({ type: "image", data: "AAAA", mimeType: "image/png" })).toEqual({
      kind: "image",
      src: "data:image/png;base64,AAAA",
      alt: "Image",
    });
    expect(blockView({ type: "image", uri: "https://evil.example/x.png", mimeType: "image/png" })).toEqual({
      kind: "link",
      uri: "https://evil.example/x.png",
      name: "https://evil.example/x.png",
    });
    expect(blockView({ type: "image", data: "PHN2Zz4=", mimeType: "image/svg+xml" })).toEqual({
      kind: "unknown",
      type: "image",
    });
  });

  it("reads text, links, resources and unknown blocks", () => {
    expect(blockView({ type: "text", text: "hi" })).toEqual({ kind: "text", text: "hi" });
    expect(blockView({ type: "resource_link", uri: "file:///workspace/a.ts", name: "a.ts" })).toEqual({
      kind: "link",
      uri: "file:///workspace/a.ts",
      name: "a.ts",
    });
    expect(blockView({ type: "resource", resource: { uri: "file:///x", text: "body" } })).toEqual({
      kind: "resource",
      uri: "file:///x",
      text: "body",
    });
    expect(blockView({ type: "audio", data: "AA", mimeType: "audio/wav" })).toEqual({
      kind: "audio",
      src: "data:audio/wav;base64,AA",
    });
    expect(blockView({ type: "mystery" })).toEqual({ kind: "unknown", type: "mystery" });
  });

  it("reads tool call content", () => {
    expect(toolContentView({ type: "content", content: { type: "text", text: "out" } })).toEqual({
      kind: "block",
      block: { kind: "text", text: "out" },
    });
    expect(toolContentView({ type: "diff", path: "/workspace/a", oldText: null, newText: "x" })).toEqual({
      kind: "diff",
      path: "/workspace/a",
      oldText: "",
      newText: "x",
    });
    expect(toolContentView({ type: "terminal", terminalId: "term-1" })).toEqual({
      kind: "terminal",
      terminalId: "term-1",
    });
  });
});

describe("unified hunks", () => {
  it("keeps three lines of context around each change", () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");
    const next = old.replace("l10", "L10").replace("l11", "L11");
    const hunks = toUnifiedHunks(diffLines(old, next));
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.header).toBe("@@ -7,8 +7,8 @@");
    expect(hunks[0]!.lines.map((l) => l.kind)).toEqual([
      "context",
      "context",
      "context",
      "del",
      "del",
      "add",
      "add",
      "context",
      "context",
      "context",
    ]);
  });

  it("splits far apart changes and handles a new file", () => {
    const old = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n");
    const next = old.replace("l2\n", "X\n").replace("l28", "Y");
    expect(toUnifiedHunks(diffLines(old, next))).toHaveLength(2);
    const added = toUnifiedHunks(diffLines("", "a\nb"));
    expect(added[0]!.header).toBe("@@ -0,0 +1,2 @@");
    expect(toUnifiedHunks(diffLines("same", "same"))).toEqual([]);
  });
});

describe("turn footer", () => {
  it("shows the duration and a word for turns that did not finish normally", () => {
    expect(turnDuration(turn({ startedAt: 1000, endedAt: 13_000 }))).toBe(12_000);
    expect(turnDuration(turn({ startedAt: null, endedAt: 13_000 }))).toBeNull();
    expect(turnOutcome(turn({ status: "completed", stopReason: "end_turn" }))).toBeNull();
    expect(turnOutcome(turn({ status: "cancelled" }))).toBe("Stopped");
    expect(turnOutcome(turn({ status: "completed", stopReason: "max_tokens" }))).toBe("Hit the token limit");
  });

  it("counts plan entries", () => {
    expect(
      planProgress([{ status: "completed" }, { status: "in_progress" }, { status: "completed" }]),
    ).toEqual({
      done: 2,
      total: 3,
    });
  });
});
