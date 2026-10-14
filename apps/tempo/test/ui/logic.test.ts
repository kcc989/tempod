import { DEFAULT_SETTINGS } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import { hasLogin, togglePlanTarget } from "~/ui/lib/agents";
import { diffLines, parseUnifiedDiff, toSplitRows } from "~/ui/lib/diff";
import { hashString, stripAnsi } from "~/ui/lib/format";
import { fuzzyFilter } from "~/ui/lib/fuzzy";
import { pillText, primaryAction, statusIndicator, titleFor } from "~/ui/lib/indicators";
import { BINDINGS, SHORTCUT_ROWS, formatCombo, matchGlobal, matches, matchesCombo } from "~/ui/lib/shortcuts";
import { session } from "./fixtures";

const ev = (
  code: string,
  mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {},
) => ({
  code,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
});

describe("shortcuts", () => {
  it("has one row per line of the 04 table", () => {
    expect(SHORTCUT_ROWS).toHaveLength(32);
    expect(new Set(BINDINGS.map((b) => b.id)).size).toBe(BINDINGS.length);
  });

  it("uses ⌘ only where 04 allows it", () => {
    const modCodes = BINDINGS.filter((b) => b.key.mod).map((b) => formatCombo(b.key, true));
    expect(modCodes.sort()).toEqual(["⌘/", "⌘B", "⌘K", "⌘P", "⌘U", "⌘⇧F", "⌘⌥B"].sort());
  });

  it("matches on code with exact modifiers, ⌘ = Meta on macOS and Ctrl elsewhere", () => {
    expect(matchGlobal(ev("KeyN", { alt: true }), true)?.id).toBe("newWorkspace");
    expect(matchGlobal(ev("KeyN", { alt: true, shift: true }), true)).toBeUndefined();
    expect(matchGlobal(ev("KeyK", { meta: true }), true)?.id).toBe("palette");
    expect(matchGlobal(ev("KeyK", { ctrl: true }), true)).toBeUndefined();
    expect(matchGlobal(ev("KeyK", { ctrl: true }), false)?.id).toBe("palette");
    expect(matchGlobal(ev("KeyB", { meta: true, alt: true }), true)?.id).toBe("toggleRight");
    expect(matchGlobal(ev("KeyB", { meta: true }), true)?.id).toBe("toggleSidebar");
    expect(matchGlobal(ev("Digit3", { alt: true }), true)?.id).toBe("workspace3");
    expect(matchGlobal(ev("KeyO", { ctrl: true }), true)?.id).toBe("expandAll");
    expect(matchGlobal(ev("KeyF", { ctrl: true, shift: true }), false)?.id).toBe("searchFiles");
    expect(matches(ev("Enter", { shift: true }), "newLine", true)).toBe(true);
    expect(matches(ev("Enter"), "send", true)).toBe(true);
    expect(matchesCombo(ev("KeyJ"), { code: "KeyJ" }, true)).toBe(true);
  });

  it("formats keys per platform", () => {
    expect(formatCombo({ code: "Comma", alt: true }, true)).toBe("⌥,");
    expect(formatCombo({ code: "KeyF", mod: true, shift: true }, false)).toBe("Ctrl+Shift+F");
  });
});

describe("indicators", () => {
  it("follows the first-match order of the 04 table", () => {
    expect(statusIndicator({ attention: "needs_input", state: "working" })?.kind).toBe("needs_input");
    expect(statusIndicator({ attention: "error", state: "working" })?.kind).toBe("error");
    expect(statusIndicator({ attention: "unread", state: "working" })?.kind).toBe("working");
    expect(statusIndicator({ attention: "unread", state: "ready" })?.kind).toBe("unread");
    expect(statusIndicator({ attention: "none", state: "stopping" })).toEqual({
      kind: "busy",
      tooltip: "Going to sleep",
    });
    expect(statusIndicator({ attention: "none", state: "sleeping" })?.kind).toBe("sleeping");
    expect(statusIndicator({ attention: "none", state: "ready" })).toBeNull();
  });

  it("writes the pill text per state", () => {
    const op = { kind: "wake", status: "running", step: "container.start", steps: [] } as const;
    expect(pillText("starting", { op }).text).toBe("Starting… Starting container");
    expect(pillText("ready", { op: null, instance: DEFAULT_SETTINGS.environment.instance }).text).toBe(
      "Running · standard-3",
    );
    expect(pillText("error", { op: null })).toEqual({ text: "Error", tone: "error" });
    expect(pillText("stopping", { op: null }).text).toBe("Going to sleep");
  });

  it("picks the first primary action that applies", () => {
    const base = {
      hasUncommitted: false,
      hasUnpushedCommits: false,
      pushed: false,
      prNumber: null,
      prState: null,
      checksState: null,
    } as const;

    expect(primaryAction({ ...base, hasUncommitted: true, prNumber: 3, prState: "open" })?.kind).toBe(
      "commitPush",
    );
    expect(primaryAction({ ...base, pushed: true })?.kind).toBe("createPr");
    expect(
      primaryAction({ ...base, pushed: true, prNumber: 3, prState: "open", checksState: "failure" })?.kind,
    ).toBe("viewChecks");
    expect(primaryAction({ ...base, pushed: true, prNumber: 3, prState: "open" })?.kind).toBe("merge");
    expect(primaryAction({ ...base, pushed: true, prNumber: 3, prState: "merged" })?.kind).toBe("archive");
    expect(primaryAction(base)).toBeNull();
  });

  it("titles the tab with the attention count", () => {
    expect(titleFor(0)).toBe("Tempo");
    expect(titleFor(3)).toBe("(3) Tempo");
  });
});

describe("agents", () => {
  const creds = (set: string[]) => ({
    claude: { set: set.includes("claude"), updatedAt: null },
    codex: { set: set.includes("codex"), updatedAt: null, lastRefresh: null },
    openrouter: { set: set.includes("openrouter"), updatedAt: null },
    anthropic: { set: set.includes("anthropic"), updatedAt: null },
    openai: { set: set.includes("openai"), updatedAt: null },
  });

  it("knows which login each agent needs", () => {
    expect(hasLogin("claude", creds(["anthropic"]))).toBe(true);
    expect(hasLogin("codex", creds(["claude"]))).toBe(false);
    expect(hasLogin("opencode", creds(["openrouter"]))).toBe(true);
    expect(hasLogin("pi", creds([]))).toBe(false);
  });

  it("toggles plan mode with the agent's plan id", () => {
    const modes = [
      { id: "default", name: "Default" },
      { id: "bypassPermissions", name: "Bypass" },
      { id: "plan", name: "Plan" },
    ];

    expect(togglePlanTarget(session({ modes, modeId: "bypassPermissions" }), null)).toBe("plan");
    expect(togglePlanTarget(session({ modes, modeId: "plan" }), "default")).toBe("default");
    expect(togglePlanTarget(session({ modes, modeId: "plan" }), null)).toBe("bypassPermissions");
    expect(togglePlanTarget(session({ agent: "pi", modes: [], modeId: null }), null)).toBeNull();
    expect(
      togglePlanTarget(
        session({ agent: "codex", modes: [{ id: "read-only", name: "R" }], modeId: "x" }),
        null,
      ),
    ).toBe("read-only");
  });
});

describe("diffs", () => {
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "index 1..2 100644",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,4 +1,4 @@",
    " a",
    "-b",
    "-c",
    "+B",
    " d",
    "\\ No newline at end of file",
    "@@ -10,2 +10,3 @@ fn",
    " x",
    "+y",
    " z",
    "",
  ].join("\n");

  it("parses hunks with line numbers", () => {
    const p = parseUnifiedDiff(diff);
    expect(p.hunks).toHaveLength(2);
    expect(p.additions).toBe(2);
    expect(p.deletions).toBe(2);
    expect(p.hunks[0]!.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ["context", 1, 1],
      ["del", 2, null],
      ["del", 3, null],
      ["add", null, 2],
      ["context", 4, 3],
    ]);
    expect(p.hunks[1]!.lines[1]).toEqual({ kind: "add", text: "y", oldLine: null, newLine: 11 });
  });

  it("pairs deletions and additions for split view", () => {
    const rows = toSplitRows(parseUnifiedDiff(diff).hunks[0]!);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["a", "a"],
      ["b", "B"],
      ["c", null],
      ["d", "d"],
    ]);
  });

  it("detects binary diffs", () => {
    expect(
      parseUnifiedDiff("diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n").binary,
    ).toBe(true);
  });

  it("line diff reproduces both texts", () => {
    const rnd = (seed: number) => () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;

      return seed / 0x7fffffff;
    };

    const r = rnd(7);

    for (let n = 0; n < 200; n++) {
      const a = Array.from({ length: Math.floor(r() * 12) }, () => "abcd"[Math.floor(r() * 4)]!);
      const b = Array.from({ length: Math.floor(r() * 12) }, () => "abcd"[Math.floor(r() * 4)]!);
      const lines = diffLines(a.join("\n"), b.join("\n"));
      expect(lines.filter((l) => l.kind !== "add").map((l) => l.text)).toEqual(a);
      expect(lines.filter((l) => l.kind !== "del").map((l) => l.text)).toEqual(b);
    }

    const small = diffLines("a\nb\nc\n", "a\nx\nc\n");
    expect(small.map((l) => l.kind)).toEqual(["context", "del", "add", "context"]);
  });
});

describe("text helpers", () => {
  it("strips ANSI escapes and carriage-return redraws", () => {
    expect(stripAnsi("\u001b[32mok\u001b[0m\n10%\r50%\r100%\n")).toBe("ok\n100%\n");
  });

  it("hashes deterministically", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
  });

  it("fuzzy matches file names first", () => {
    const paths = ["src/ui/components/sidebar.tsx", "docs/side notes.md", "src/server/fns.ts"];
    expect(fuzzyFilter("sidebar", paths, (p) => p)[0]).toBe("src/ui/components/sidebar.tsx");
    expect(fuzzyFilter("fns", paths, (p) => p)).toEqual(["src/server/fns.ts"]);
    expect(fuzzyFilter("zzz", paths, (p) => p)).toEqual([]);
  });
});
