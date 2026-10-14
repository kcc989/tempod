import { describe, expect, it } from "bun:test";
import { Option } from "effect";
import { staleEntries, usedHashes } from "./ci-cache.ts";

describe("ci task cache pruning", () => {
  it("keeps every file of a used task hash and removes the rest", () => {
    const files = [
      "aaaa.tar.zst",
      "aaaa-meta.json",
      "aaaa-manifest.json",
      "bbbb.tar.zst",
      "bbbb-meta.json",
      "cccc-manifest.json",
    ];

    expect(staleEntries(files, new Set(["aaaa", "cccc"]))).toEqual(["bbbb.tar.zst", "bbbb-meta.json"]);
  });

  it("collects task hashes from every run summary", () => {
    const used = usedHashes([
      JSON.stringify({ id: "1", tasks: [{ taskId: "a#build", hash: "aaaa" }] }),
      JSON.stringify({ id: "2", tasks: [{ taskId: "b#test", hash: "bbbb" }] }),
    ]);

    expect(Option.map(used, (set) => [...set].sort())).toEqual(Option.some(["aaaa", "bbbb"]));
  });

  it("prunes nothing when a summary is unreadable or names no task", () => {
    expect(usedHashes([JSON.stringify({ tasks: [{ hash: "aaaa" }] }), "{"])).toEqual(Option.none());
    expect(usedHashes([JSON.stringify({ tasks: [] })])).toEqual(Option.none());
  });
});
