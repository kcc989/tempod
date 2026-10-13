import { describe, expect, it } from "vitest";
import { parsePrGuide } from "../src/pr-guide.ts";

const guide = {
  version: 1,
  title: "Cache requests",
  summary: "Cache repeated reads.",
  before: "Every read calls the database.",
  after: "Repeated reads use the cache.",
  chapters: [
    {
      id: "cache",
      title: "Cache lookup",
      description: "Check the cache first.",
      files: ["src/cache.ts"],
      visuals: [
        {
          kind: "flow",
          title: "Reads",
          nodes: [
            { id: "cache", label: "Cache", description: "Look up a key.", path: "src/cache.ts" },
            { id: "db", label: "Database", description: "Read on a miss." },
          ],
          edges: [{ from: "cache", to: "db", label: "miss" }],
        },
        { kind: "comparison", title: "Result", before: "Database", after: "Cache" },
        { kind: "html", title: "Try a cache miss", path: ".tempo/artifacts/cache.html" },
      ],
    },
  ],
};

describe("guided PR documents", () => {
  it("loads several interactive visuals in an ordered chapter", () => {
    expect(parsePrGuide(JSON.stringify(guide))).toEqual(guide);
  });
  it.each([
    "/etc/passwd",
    "../secret",
    "src/../secret",
    "src/./secret",
    "src//cache.ts",
    "src\\cache.ts",
    "src/cache.ts\n",
    "src/\u0000cache.ts",
    ".",
    "..",
  ])("rejects unsafe file or artifact paths: %s", (path) => {
    const invalid = structuredClone(guide);
    invalid.chapters[0]!.files = [path];
    expect(() => parsePrGuide(JSON.stringify(invalid))).toThrow();
    invalid.chapters[0]!.files = [];
    invalid.chapters[0]!.visuals = [{ kind: "html", title: "Artifact", path }];
    expect(() => parsePrGuide(JSON.stringify(invalid))).toThrow();
  });
  it("rejects unknown versions and empty chapters", () => {
    expect(() => parsePrGuide(JSON.stringify({ ...guide, version: 2 }))).toThrow();
    expect(() => parsePrGuide(JSON.stringify({ ...guide, chapters: [] }))).toThrow();
    expect(() => parsePrGuide("not json")).toThrow();
  });
  it("rejects duplicate chapter ids and malformed graphs", () => {
    expect(() =>
      parsePrGuide(JSON.stringify({ ...guide, chapters: [guide.chapters[0], guide.chapters[0]] })),
    ).toThrow("Chapter ids");
    const invalid = structuredClone(guide);
    const flow = invalid.chapters[0]!.visuals[0]!;

    if (flow.kind !== "flow" || !flow.nodes || !flow.edges) throw new Error("Expected flow");
    flow.edges[0]!.to = "missing";
    expect(() => parsePrGuide(JSON.stringify(invalid))).toThrow("existing nodes");
    flow.edges = [];
    flow.nodes[1]!.id = "cache";
    expect(() => parsePrGuide(JSON.stringify(invalid))).toThrow("node ids");
  });
});
