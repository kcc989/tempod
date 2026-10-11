import { describe, expect, it } from "vitest";
import { CITIES, SLUG_PATTERN, pickSlug } from "../src/index.ts";

describe("pickSlug", () => {
  it("picks the first unused city", () => {
    expect(pickSlug([])).toBe("lisbon");
    expect(pickSlug(["lisbon"])).toBe("porto");
  });
  it("adds -2, -3 to the first name when all are used", () => {
    expect(pickSlug(CITIES)).toBe("lisbon-2");
    expect(pickSlug([...CITIES, "lisbon-2"])).toBe("lisbon-3");
  });
  it("every city is a valid, unique slug", () => {
    expect(new Set(CITIES).size).toBe(CITIES.length);
    for (const c of CITIES) expect(c).toMatch(SLUG_PATTERN);
  });
});
