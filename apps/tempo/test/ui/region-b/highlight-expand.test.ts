import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getExpandState,
  isExpanded,
  resetExpand,
  toggleExpandAll,
  toggleExpanded,
} from "~/ui/components/chat/expand-store";
import {
  highlight,
  MAX_HIGHLIGHT_CHARS,
  resolveLanguage,
  toReactStyle,
} from "~/ui/components/chat/highlight";

beforeEach(() => vi.stubEnv("SSR", false));

afterEach(() => {
  resetExpand();
  vi.unstubAllEnvs();
});

describe("expand all tool calls (⌃O)", () => {
  it("toggles all, and single rows on top of that", () => {
    const open = (id: string) => isExpanded(getExpandState(), "s1", id);
    expect(open("a")).toBe(false);
    toggleExpanded("s1", "a");
    expect(open("a")).toBe(true);
    toggleExpandAll("s1");
    expect([open("a"), open("b")]).toEqual([true, true]);
    toggleExpanded("s1", "b");
    expect(open("b")).toBe(false);
    toggleExpandAll("s1");
    expect([open("a"), open("b")]).toEqual([false, false]);
    expect(isExpanded(getExpandState(), "s2", "a")).toBe(false);
  });
});

describe("code highlighting", () => {
  it("keeps server renders plain without loading browser grammars", async () => {
    vi.stubEnv("SSR", true);
    expect(await highlight("const serverOnly = 1;", "ts")).toBeNull();
    const { highlightFile } = await import("~/ui/components/review/highlight");
    expect(await highlightFile("const serverOnly = 2;", "app.ts")).toBeNull();
  });
  it("converts Shiki styles for React and keeps custom properties", () => {
    expect(toReactStyle({ color: "#111", "font-style": "italic", "--shiki-dark": "#eee" })).toEqual({
      color: "#111",
      fontStyle: "italic",
      "--shiki-dark": "#eee",
    });
    expect(toReactStyle(undefined)).toBeUndefined();
  });

  it("resolves fence languages", () => {
    const known = { typescript: 1, ts: 1, bash: 1 };
    expect(resolveLanguage("TS", known)).toBe("ts");
    expect(resolveLanguage("bash {1,3}", known)).toBe("bash");
    expect(resolveLanguage("text", known)).toBeNull();
    expect(resolveLanguage("klingon", known)).toBeNull();
    expect(resolveLanguage("", known)).toBeNull();
  });

  it("loads Shiki on demand and gives light and dark colours", async () => {
    const lines = await highlight("const a = 1;\nlet b = a;", "ts");
    expect(lines).toHaveLength(2);
    const tokens = lines!.flat();
    expect(tokens.map((t) => t.content).join("")).toBe("const a = 1;let b = a;");
    expect(tokens.some((t) => t.style && "--shiki-dark" in t.style)).toBe(true);
    expect(await highlight("x", "klingon")).toBeNull();
    expect(await highlight("x".repeat(MAX_HIGHLIGHT_CHARS + 1), "ts")).toBeNull();
  }, 30_000);
});
