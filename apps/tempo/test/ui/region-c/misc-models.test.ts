import { describe, expect, it } from "vitest";
import {
  normalizeUrl,
  PREVIEW_SANDBOX,
  previewPortOf,
  safeHttpUrl,
} from "~/ui/components/review/browser-model";
import {
  checksStateLabel,
  prStateLabel,
  runLabel,
  runOutcome,
  sortRuns,
} from "~/ui/components/review/checks-model";
import { languageFor, splitLines } from "~/ui/components/review/highlight";
import { groupMatches, SEARCH_LIMIT } from "~/ui/components/review/search-model";
import { fuzzyFilter } from "~/ui/lib/fuzzy";

describe("Checks tab", () => {
  const run = (name: string, status: string, conclusion: string | null) => ({
    name,
    status,
    conclusion,
    url: `https://github.com/acme/app/runs/${name}`,
  });

  it("maps check runs as 03 Status polling does", () => {
    expect(runOutcome(run("a", "queued", null))).toBe("pending");
    expect(runOutcome(run("a", "in_progress", null))).toBe("pending");
    for (const c of ["failure", "cancelled", "timed_out", "action_required"]) {
      expect(runOutcome(run("a", "completed", c))).toBe("failure");
    }
    expect(runOutcome(run("a", "completed", "success"))).toBe("success");
    expect(runOutcome(run("a", "completed", "skipped"))).toBe("neutral");
  });

  it("labels a run by its conclusion, or its status while running", () => {
    expect(runLabel(run("a", "completed", "timed_out"))).toBe("Timed out");
    expect(runLabel(run("a", "in_progress", null))).toBe("In progress");
  });

  it("lists failures first, then running, then the rest", () => {
    const sorted = sortRuns([
      run("lint", "completed", "success"),
      run("test", "completed", "failure"),
      run("build", "in_progress", null),
      run("docs", "completed", "skipped"),
      run("e2e", "completed", "success"),
    ]);
    expect(sorted.map((r) => r.name)).toEqual(["test", "build", "e2e", "lint", "docs"]);
  });

  it("labels the PR and checks states", () => {
    expect(prStateLabel("open")).toEqual({ label: "Open", tone: "success" });
    expect(prStateLabel("merged")).toEqual({ label: "Merged", tone: "merged" });
    expect(prStateLabel(null)).toBeNull();
    expect(checksStateLabel("failure")).toEqual({ label: "Checks failed", tone: "danger" });
    expect(checksStateLabel(null)).toBeNull();
  });
});

describe("Browser tab", () => {
  const current = "https://3000-01jaxk3v2m9q8r7t6y5w4e3d2c.previews.example.com/app";

  it("keeps paths on the preview's origin", () => {
    expect(normalizeUrl("/about?x=1", current)).toBe(
      "https://3000-01jaxk3v2m9q8r7t6y5w4e3d2c.previews.example.com/about?x=1",
    );
  });

  it("adds https to a bare host", () => {
    expect(normalizeUrl("example.com/a", current)).toBe("https://example.com/a");
    expect(normalizeUrl("localhost:3000", current)).toBe("https://localhost:3000/");
    expect(normalizeUrl("//example.com", current)).toBe("https://example.com/");
    expect(normalizeUrl("http://example.com", current)).toBe("http://example.com/");
  });

  it("refuses scripts and other schemes", () => {
    expect(normalizeUrl("javascript:alert(1)", current)).toBeNull();
    expect(normalizeUrl("data:text/html,hi", current)).toBeNull();
    expect(normalizeUrl("file:///etc/passwd", current)).toBeNull();
    expect(normalizeUrl("   ", current)).toBeNull();
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("https://github.com/a")).toBe("https://github.com/a");
  });

  it("finds the port of this workspace's preview URLs only (01, Preview URL)", () => {
    const id = "01jaxk3v2m9q8r7t6y5w4e3d2c";
    expect(previewPortOf(current, id)).toBe(3000);
    expect(
      previewPortOf("https://5173-01jaxk3v2m9q8r7t6y5w4e3d2c.previews.example.com/", id.toUpperCase()),
    ).toBe(5173);
    expect(previewPortOf(current, "01jaxk3v2m9q8r7t6y5w4e3d2d")).toBeNull();
    expect(previewPortOf("https://example.com/", id)).toBeNull();
    expect(previewPortOf("https://80-01jaxk3v2m9q8r7t6y5w4e3d2c.previews.example.com/", id)).toBeNull();
    expect(previewPortOf("not a url", id)).toBeNull();
  });

  it("never lets the preview navigate the Tempo page", () => {
    expect(PREVIEW_SANDBOX).not.toContain("allow-top-navigation");
    expect(PREVIEW_SANDBOX).toContain("allow-scripts");
  });
});

describe("File tab", () => {
  const known = { ts: 1, tsx: 1, js: 1, docker: 1, make: 1, yaml: 1, markdown: 1, python: 1, py: 1 };

  it("picks the Shiki language from the file name", () => {
    expect(languageFor("src/a.ts", known)).toBe("ts");
    expect(languageFor("src/a.mts", known)).toBe("ts");
    expect(languageFor("Dockerfile", known)).toBe("docker");
    expect(languageFor("dir/Makefile", known)).toBe("make");
    expect(languageFor("ci.yml", known)).toBe("yaml");
    expect(languageFor("README.md", known)).toBe("markdown");
    expect(languageFor("notes.txt", known)).toBeNull();
    expect(languageFor(".gitignore", known)).toBeNull();
    expect(languageFor("a.unknown", known)).toBeNull();
  });

  it("splits lines without an empty last line or CRs", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([""]);
  });
});

describe("⌘⇧F results", () => {
  it("groups matches by file in server order, lines ascending", () => {
    const groups = groupMatches([
      { path: "b.ts", line: 9, text: "  b9 " },
      { path: "a.ts", line: 3, text: "a3" },
      { path: "b.ts", line: 2, text: "b2" },
      { path: "b.ts", line: 2, text: "b2 again" },
    ]);
    expect(groups).toEqual([
      {
        path: "b.ts",
        matches: [
          { line: 2, text: "b2" },
          { line: 9, text: "b9" },
        ],
      },
      { path: "a.ts", matches: [{ line: 3, text: "a3" }] },
    ]);
    expect(SEARCH_LIMIT).toBe(500);
  });
});

describe("⌘P fuzzy ranking", () => {
  const paths = [
    "src/ui/components/review/DiffTab.tsx",
    "docs/diff.md",
    "src/ui/lib/diff.ts",
    "src/difficult/index.ts",
    "README.md",
  ];

  it("ranks file-name matches above folder matches and drops non-matches", () => {
    const out = fuzzyFilter("diff", paths, (p) => p);
    expect(out[0]).toBe("src/ui/lib/diff.ts");
    expect(out.indexOf("src/ui/components/review/DiffTab.tsx")).toBeLessThan(
      out.indexOf("src/difficult/index.ts"),
    );
    expect(out).not.toContain("README.md");
  });

  it("matches a subsequence across folders", () => {
    expect(fuzzyFilter("revdt", paths, (p) => p)).toEqual(["src/ui/components/review/DiffTab.tsx"]);
  });

  it("lists files in order when the query is empty", () => {
    expect(fuzzyFilter("", paths, (p) => p, 2)).toEqual(paths.slice(0, 2));
  });
});
