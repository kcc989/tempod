import type { ReviewComment } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import {
  commentLocation,
  currentFileIndex,
  diffHash,
  diffLineCount,
  drafts,
  effectiveView,
  EMPTY_MARKS,
  extendSelection,
  inRange,
  isDiffView,
  isViewed,
  isViewedMarks,
  lineKeys,
  MAX_VIEWED_MARKS,
  placeComments,
  rangeLabel,
  selectionRange,
  sendLabel,
  splitRefs,
  splitRowKeys,
  stepFileIndex,
  unifiedRef,
  viewedKey,
  withViewed,
} from "~/ui/components/review/diff-model";
import { parseUnifiedDiff, toSplitRows } from "~/ui/lib/diff";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,5 @@",
  " one",
  "-two",
  "-three",
  "+TWO",
  "+THREE",
  "+extra",
  " four",
  "",
].join("\n");

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: "c1",
  path: "src/a.ts",
  lineStart: null,
  lineEnd: null,
  side: null,
  body: "Look here",
  status: "draft",
  sentTurnId: null,
  createdAt: 1,
  ...over,
});

describe("view mode (04: unified only below 1024 px)", () => {
  it("forces unified on narrow screens", () => {
    expect(effectiveView("split", true)).toBe("unified");
    expect(effectiveView("split", false)).toBe("split");
    expect(effectiveView("unified", false)).toBe("unified");
  });

  it("guards the stored value", () => {
    expect(isDiffView("split")).toBe(true);
    expect(isDiffView("side-by-side")).toBe(false);
  });
});

describe("viewed marks with the diff hash", () => {
  it("hashes the diff text so a changed diff clears the mark", () => {
    const h1 = diffHash(DIFF);
    const h2 = diffHash(DIFF.replace("+extra", "+more"));
    expect(h1).toMatch(/^[0-9a-f]{8}$/);
    expect(h1).not.toBe(h2);
    const marks = withViewed(EMPTY_MARKS, "src/a.ts", h1, true);
    expect(isViewed(marks, "src/a.ts", h1)).toBe(true);
    expect(isViewed(marks, "src/a.ts", h2)).toBe(false);
    expect(isViewed(marks, "src/a.ts", null)).toBe(false);
  });

  it("clears a mark and keeps the others", () => {
    let marks = withViewed(EMPTY_MARKS, "a", "1", true);
    marks = withViewed(marks, "b", "2", true);
    marks = withViewed(marks, "a", "1", false);
    expect(marks).toEqual({ b: "2" });
  });

  it("drops the oldest marks past the cap", () => {
    let marks = EMPTY_MARKS;

    for (let i = 0; i <= MAX_VIEWED_MARKS; i++) marks = withViewed(marks, `f${i}`, "h", true);
    expect(Object.keys(marks)).toHaveLength(MAX_VIEWED_MARKS);
    expect(marks["f0"]).toBeUndefined();
    expect(marks[`f${MAX_VIEWED_MARKS}`]).toBe("h");
  });

  it("validates what comes back from localStorage", () => {
    expect(isViewedMarks({ a: "1" })).toBe(true);
    expect(isViewedMarks({ a: 1 })).toBe(false);
    expect(isViewedMarks(["a"])).toBe(false);
    expect(isViewedMarks(null)).toBe(false);
    expect(viewedKey("w1")).toBe("review:viewed:w1");
  });
});

describe("split view pairing and line refs", () => {
  const parsed = parseUnifiedDiff(DIFF);
  const hunk = parsed.hunks[0]!;

  it("pairs each run of deletions with the additions after it", () => {
    const rows = toSplitRows(hunk);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["one", "one"],
      ["two", "TWO"],
      ["three", "THREE"],
      [null, "extra"],
      ["four", "four"],
    ]);
    expect(splitRefs(rows[1]!)).toEqual({ left: { side: "old", line: 2 }, right: { side: "new", line: 2 } });
    expect(splitRefs(rows[3]!)).toEqual({ left: null, right: { side: "new", line: 4 } });
    expect(splitRowKeys(rows[0]!)).toEqual(["old:1", "new:1"]);
  });

  it("puts deletions on the old side and the rest on the new side in unified view", () => {
    const [ctx, del, , add] = hunk.lines;
    expect(unifiedRef(ctx!)).toEqual({ side: "new", line: 1 });
    expect(unifiedRef(del!)).toEqual({ side: "old", line: 2 });
    expect(unifiedRef(add!)).toEqual({ side: "new", line: 2 });
    expect(lineKeys(ctx!)).toEqual(["old:1", "new:1"]);
    expect(lineKeys(del!)).toEqual(["old:2"]);
    expect(diffLineCount(parsed)).toBe(7);
  });
});

describe("line selection for comments", () => {
  it("orders a dragged range either way", () => {
    expect(selectionRange({ side: "new", anchor: 9, focus: 4 })).toEqual({
      side: "new",
      lineStart: 4,
      lineEnd: 9,
    });
    expect(rangeLabel({ side: "new", lineStart: 4, lineEnd: 4 })).toBe("Line 4");
    expect(rangeLabel({ side: "new", lineStart: 4, lineEnd: 9 })).toBe("Lines 4 to 9");
  });

  it("extends on the same side and restarts on the other", () => {
    const s = { side: "new" as const, anchor: 3, focus: 3 };
    expect(extendSelection(s, { side: "new", line: 6 })).toEqual({ side: "new", anchor: 3, focus: 6 });
    expect(extendSelection(s, { side: "old", line: 6 })).toEqual({ side: "old", anchor: 6, focus: 6 });
    expect(extendSelection(null, { side: "old", line: 2 })).toEqual({ side: "old", anchor: 2, focus: 2 });
  });

  it("matches lines only on the range's side", () => {
    const r = { side: "new" as const, lineStart: 2, lineEnd: 4 };
    expect(inRange(r, { side: "new", line: 3 })).toBe(true);
    expect(inRange(r, { side: "old", line: 3 })).toBe(false);
    expect(inRange(r, { side: "new", line: 5 })).toBe(false);
    expect(inRange(null, { side: "new", line: 3 })).toBe(false);
  });
});

describe("placing draft comments", () => {
  const parsed = parseUnifiedDiff(DIFF);

  it("puts a comment under its last line, and whole-file or stale ones under the header", () => {
    const onRange = comment({ id: "r", lineStart: 2, lineEnd: 4, side: "new" });
    const onOld = comment({ id: "o", lineStart: 3, lineEnd: 3, side: "old" });
    const whole = comment({ id: "w" });
    const stale = comment({ id: "s", lineStart: 40, lineEnd: 41, side: "new" });
    const placed = placeComments(parsed, [onRange, onOld, whole, stale]);
    expect(placed.byAnchor.get("new:4")?.map((c) => c.id)).toEqual(["r"]);
    expect(placed.byAnchor.get("old:3")?.map((c) => c.id)).toEqual(["o"]);
    expect(placed.fileLevel.map((c) => c.id)).toEqual(["w", "s"]);
  });

  it("puts every line comment under the header while the diff is not loaded", () => {
    const placed = placeComments(null, [comment({ lineStart: 1, lineEnd: 1, side: "new" })]);
    expect(placed.fileLevel).toHaveLength(1);
    expect(placed.byAnchor.size).toBe(0);
  });

  it("keeps only drafts", () => {
    expect(drafts([comment({ id: "a" }), comment({ id: "b", status: "sent" })]).map((c) => c.id)).toEqual([
      "a",
    ]);
    expect(drafts(undefined)).toEqual([]);
  });

  it("names the place of a comment", () => {
    expect(commentLocation(comment())).toBe("src/a.ts");
    expect(commentLocation(comment({ lineStart: 3, lineEnd: 3 }))).toBe("src/a.ts:3");
    expect(commentLocation(comment({ lineStart: 3, lineEnd: 7 }))).toBe("src/a.ts:3-7");
  });

  it("labels the send button", () => {
    expect(sendLabel(1, "Claude")).toBe("Send 1 comment to Claude");
    expect(sendLabel(3, "Codex")).toBe("Send 3 comments to Codex");
  });
});

describe("J and K between stacked files", () => {
  const tops = [0, 300, 900];

  it("finds the file at the top of the view", () => {
    expect(currentFileIndex(tops, 0)).toBe(0);
    expect(currentFileIndex(tops, 299)).toBe(1);
    expect(currentFileIndex(tops, 500)).toBe(1);
    expect(currentFileIndex(tops, 2000)).toBe(2);
  });

  it("moves to the next file, and stops at the last", () => {
    expect(stepFileIndex(tops, 0, 1)).toBe(1);
    expect(stepFileIndex(tops, 450, 1)).toBe(2);
    expect(stepFileIndex(tops, 900, 1)).toBeNull();
    expect(stepFileIndex([], 0, 1)).toBeNull();
  });

  it("goes back to the start of the current file first, then to the previous one", () => {
    expect(stepFileIndex(tops, 450, -1)).toBe(1);
    expect(stepFileIndex(tops, 300, -1)).toBe(0);
    expect(stepFileIndex(tops, 0, -1)).toBeNull();
  });

  it("starts at the first file when it is below the top", () => {
    expect(stepFileIndex([40, 300], 0, 1)).toBe(0);
    expect(stepFileIndex([40, 300], 0, -1)).toBeNull();
  });
});
