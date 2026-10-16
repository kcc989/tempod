import { describe, expect, it } from "vitest";
import { ANIMALS, SLUG_PATTERN, pickSlug, promptSlug } from "../src/index.ts";

describe("pickSlug", () => {
  it("picks a random unused animal", () => {
    expect(pickSlug([], () => 0)).toBe("otter");
    expect(pickSlug([], () => 0.999)).toBe("beetle");
    expect(pickSlug(["otter"], () => 0)).toBe("fox");
    expect(pickSlug(ANIMALS.filter((a) => a !== "lynx"), () => 0.999)).toBe("lynx");
  });
  it("adds -2, -3 to a random name when all are used", () => {
    expect(pickSlug(ANIMALS, () => 0)).toBe("otter-2");
    expect(pickSlug([...ANIMALS, "otter-2"], () => 0)).toBe("otter-3");
    expect(pickSlug(ANIMALS, () => 0.999)).toBe("beetle-2");
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
