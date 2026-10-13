import type { Item } from "@tempo/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getExpandState, isExpanded, resetExpand, toggleExpandAll } from "~/ui/components/chat/expand-store";
import { buildTranscriptRows } from "~/ui/components/chat/transcript-model";
import {
  commandIntent,
  currentStep,
  editCounts,
  toolLabel,
  workSummary,
  workType,
} from "~/ui/components/chat/work-model";
import { DETAIL_KEY, resetTranscriptDetail, setTranscriptDetail } from "~/ui/lib/transcript-detail";
import { agentMessage, turn, userMessage } from "../fixtures";
import { installLocalStorage, removeLocalStorage } from "../storage-stub";

type Tool = Extract<Item, { kind: "tool_call" }>;

const tool = (
  id: string,
  toolKind: string,
  over: {
    title?: string;
    rawInput?: unknown;
    status?: Item["status"];
    locations?: string[];
    content?: object[];
  } = {},
): Tool =>
  ({
    id,
    sessionId: "s1",
    turnId: "t1",
    kind: "tool_call",
    status: over.status ?? "completed",
    content: {
      toolCallId: id,
      title: over.title ?? id,
      toolKind,
      locations: (over.locations ?? []).map((path) => ({ path })),
      content: over.content ?? [],
      ...(over.rawInput === undefined ? {} : { rawInput: over.rawInput }),
    },
    rev: 1,
    createdAt: 1000,
    updatedAt: 1000,
  }) as Tool;

const thought = (id: string): Item =>
  ({ ...agentMessage(id, "hmm", { status: "completed" }), kind: "agent_thought" }) as Item;

const map = (...xs: Item[]): Record<string, Item> => Object.fromEntries(xs.map((x) => [x.id, x]));

describe("work types (04, Work types)", () => {
  it("maps ACP kinds and commands to one set of types", () => {
    expect(workType(tool("a", "read"))).toBe("explore");
    expect(workType(tool("a", "search"))).toBe("explore");
    expect(workType(tool("a", "edit"))).toBe("edit");
    expect(workType(tool("a", "delete"))).toBe("edit");
    expect(workType(tool("a", "move"))).toBe("edit");
    expect(workType(tool("a", "execute", { title: "bun run test" }))).toBe("run");
    expect(workType(tool("a", "execute", { title: "cat README.md" }))).toBe("explore");
    expect(workType(tool("a", "execute", { title: "x", rawInput: { command: "rg foo src" } }))).toBe(
      "explore",
    );
    expect(workType(tool("a", "fetch"))).toBe("web");
    expect(workType(tool("a", "think", { rawInput: { subagent_type: "Explore" } }))).toBe("subagent");
    expect(workType(tool("a", "think", { rawInput: { prompt: "p", description: "d" } }))).toBe("subagent");
    expect(workType(tool("a", "think", { rawInput: { subject: "task" } }))).toBe("other");
    expect(workType(tool("a", "switch_mode"))).toBe("other");
  });
});

describe("tool call labels (04, Tool call labels)", () => {
  it("uses Claude Code's Bash description first", () => {
    expect(
      toolLabel(
        tool("a", "execute", {
          title: "cd /workspace; cat README.md | head -50",
          rawInput: { description: "Read the README" },
        }),
      ),
    ).toEqual({ text: "Read the README", mono: false });
  });

  it("maps the verb of a single command", () => {
    expect(commandIntent("cat README.md")).toEqual({ verb: "Read", label: "Read README.md" });
    expect(commandIntent("cd /workspace && rg -n foo src")).toEqual({
      verb: "Search",
      label: "Search -n foo src",
    });
    expect(commandIntent("cd app; ls -la")).toEqual({ verb: "List", label: "List -la" });
    expect(commandIntent("sed -n 1,80p a.ts")).toEqual({ verb: "Read", label: "Read 1,80p a.ts" });
    expect(commandIntent("grep foo a.txt | head -5")?.verb).toBe("Search");
    expect(commandIntent("sed -i s/a/b/ a.ts")).toBeNull();
    expect(commandIntent("cat a | wc -l")).toBeNull();
    expect(commandIntent("cat a; cat b")).toBeNull();
    expect(commandIntent("ls && rm -rf x")).toBeNull();
    expect(commandIntent("cat a || true")).toBeNull();
    expect(commandIntent("cat a\ncat b")).toBeNull();
  });

  it("falls back to the title, in monospace for commands", () => {
    const cmd = "cd /workspace; cat README.md | head -50; for d in apps/*; do cat $d/package.json; done";
    expect(toolLabel(tool("a", "execute", { title: cmd }))).toEqual({ text: cmd, mono: true });
    expect(toolLabel(tool("a", "execute", { title: "cd /workspace; cat README.md | head -50" }))).toEqual({
      text: "Read README.md",
      mono: false,
    });
    expect(toolLabel(tool("a", "read", { title: "Read file 'a.ts'" }))).toEqual({
      text: "Read file 'a.ts'",
      mono: false,
    });
  });
});

describe("edit rows (04, Edit rows)", () => {
  it("counts added and removed lines from the diff", () => {
    const edit = tool("e", "edit", {
      content: [{ type: "diff", path: "/workspace/src/a.ts", oldText: "a\nb\nc\n", newText: "a\nB\nc\nd\n" }],
    });
    expect(editCounts(edit)).toEqual({ path: "/workspace/src/a.ts", added: 2, removed: 1 });
    expect(editCounts(tool("e", "edit", { locations: ["/workspace/x"] }))).toEqual({
      path: "/workspace/x",
      added: 0,
      removed: 0,
    });
    expect(editCounts(tool("e", "edit"))).toBeNull();
  });
});

describe("work row summary (04, Work row)", () => {
  it("counts each part, joins with ·, and ends with the duration", () => {
    const items = [
      tool("r1", "read", { locations: ["a", "b"] }),
      tool("r2", "read", { locations: ["b"] }),
      tool("r3", "execute", { title: "cat c" }),
      tool("s1", "search"),
      tool("x1", "execute", { title: "bun test" }),
      tool("x2", "execute", { title: "bun lint" }),
      tool("w1", "fetch"),
      tool("g1", "think", { rawInput: { subagent_type: "Explore" } }),
      tool("o1", "switch_mode"),
      thought("th"),
    ];
    expect(workSummary(items, 48_000)).toBe(
      "Explored 3 files · 1 search · ran 2 commands · fetched 1 page · ran 1 agent · used 1 tool · 48 s",
    );
  });

  it("uses singular forms, capitalises the first part, and counts thoughts only alone", () => {
    expect(workSummary([tool("x", "execute", { title: "make" })], null)).toBe("Ran 1 command");
    expect(workSummary([tool("s", "search"), tool("t", "search")], null)).toBe("2 searches");
    expect(workSummary([thought("a"), thought("b")], 2000)).toBe("Thought 2 times · 2 s");
  });

  it("names the newest step of a running row", () => {
    expect(currentStep([tool("a", "read", { title: "Read a" }), thought("t")])).toBe("Thinking");
    expect(currentStep([thought("t"), tool("b", "execute", { title: "ls" })])).toBe("List");
    expect(currentStep([])).toBeNull();
  });
});

describe("work rows in the transcript", () => {
  const ended = map(
    userMessage("u1", "Explain this repo", { turnId: "t1", createdAt: 100 }),
    agentMessage("m0", "Let me look.", { createdAt: 110, status: "completed" }),
    tool("r1", "read", { locations: ["README.md"] }),
    tool("e1", "edit"),
    tool("f1", "execute", { title: "bun test", status: "failed" }),
    tool("x1", "execute", { title: "bun lint" }),
    agentMessage("m1", "Farstep makes videos.", { createdAt: 2000, status: "completed" }),
  );
  const order = ["u1", "m0", "r1", "e1", "f1", "x1", "m1"];
  for (const [id, at] of [
    ["r1", 120],
    ["e1", 130],
    ["f1", 140],
    ["x1", 150],
  ] as const)
    (ended[id] as { createdAt: number }).createdAt = at;
  const turns = { t1: turn({ id: "t1", status: "completed", startedAt: 100, endedAt: 2100 }) };

  it("folds work into one row; edits, failures and the answer stay outside", () => {
    const rows = buildTranscriptRows(order, ended, turns);
    expect(rows.map((r) => r.key)).toEqual(["u1", "work:t1", "e1", "f1", "m1", "footer:t1"]);
    expect(rows[1]).toMatchObject({ kind: "work", itemIds: ["m0", "r1", "x1"] });
    expect(rows[5]).toMatchObject({ kind: "footer", worked: true });
  });

  it("shows every item in Detailed", () => {
    const rows = buildTranscriptRows(order, ended, turns, "detailed");
    expect(rows.map((r) => r.key)).toEqual([...order, "footer:t1"]);
    expect(rows.at(-1)).toMatchObject({ worked: false });
  });

  it("keeps the newest message outside a running row and drops the working row", () => {
    const running = { t1: turn({ id: "t1", status: "running", startedAt: 100 }) };
    const rows = buildTranscriptRows(["u1", "m0", "r1"], ended, running);
    expect(rows.map((r) => r.key)).toEqual(["u1", "work:t1", "m0"]);
    expect(buildTranscriptRows(["u1", "m0"], ended, running).map((r) => r.key)).toEqual([
      "u1",
      "m0",
      "working:t1",
    ]);
  });
});

describe("expand defaults", () => {
  beforeEach(resetExpand);

  it("opens failed calls and running work rows by default; ⌃O still toggles all", () => {
    expect(isExpanded(getExpandState(), "s1", "f1", true)).toBe(true);
    expect(isExpanded(getExpandState(), "s1", "x1")).toBe(false);
    toggleExpandAll("s1");
    expect(isExpanded(getExpandState(), "s1", "x1")).toBe(true);
  });
});

describe("transcript detail preference", () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = installLocalStorage();
    resetTranscriptDetail();
  });
  afterEach(() => {
    removeLocalStorage();
    resetTranscriptDetail();
  });

  it("defaults to Default and keeps Detailed per browser", () => {
    expect(storage.get(`tempo:${DETAIL_KEY}`)).toBeUndefined();
    setTranscriptDetail("detailed");
    expect(storage.get(`tempo:${DETAIL_KEY}`)).toBe("detailed");
    setTranscriptDetail("default");
    expect(storage.has(`tempo:${DETAIL_KEY}`)).toBe(false);
  });
});
