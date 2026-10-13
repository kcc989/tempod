import { describe, expect, it } from "vitest";
import { ANIMALS, SLUG_PATTERN, pickSlug, promptSlug } from "../src/index.ts";

describe("pickSlug", () => {
  it("picks the first unused animal", () => {
    expect(pickSlug([])).toBe("otter");
    expect(pickSlug(["otter"])).toBe("fox");
  });
  it("adds -2, -3 to the first name when all are used", () => {
    expect(pickSlug(ANIMALS)).toBe("otter-2");
    expect(pickSlug([...ANIMALS, "otter-2"])).toBe("otter-3");
  });
  it("every animal is a valid, unique slug", () => {
    expect(new Set(ANIMALS).size).toBe(ANIMALS.length);
    for (const c of ANIMALS) expect(c).toMatch(SLUG_PATTERN);
  });
});

describe("promptSlug", () => {
  it("normalizes prompt text into a bounded git-safe name", () => {
    expect(promptSlug("  Fix café login / redirect!  ")).toBe("fix-cafe-login-redirect");
    expect(promptSlug("a".repeat(100))).toHaveLength(60);
    expect(promptSlug("🐾")).toBe("");
  });
});
