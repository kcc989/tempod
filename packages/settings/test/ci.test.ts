import { TempoError } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import { parseCiPipeline } from "../src/index.ts";

const detail = (source: string): string | undefined => {
  try {
    parseCiPipeline(source);
  } catch (e) {
    if (e instanceof TempoError && e.code === "CI_PIPELINE_INVALID") return e.detail;
    throw e;
  }

  return undefined;
};

describe("parseCiPipeline", () => {
  it("applies defaults and keeps job order, needs and the explicit required list", () => {
    const spec = parseCiPipeline(
      [
        "version: 1",
        "jobs:",
        "  lint:",
        "    run: bun run lint",
        "  test:",
        "    name: ' Tests '",
        "    needs: [lint]",
        "    timeout_minutes: 30",
        "    run: |",
        "      bun install",
        "      bun test",
        "required: [test]",
        "egress_allowlist: ['*.example.com', 'pkg.example.org']",
      ].join("\n"),
    );

    expect(spec).toEqual({
      jobs: [
        { key: "lint", name: "lint", needs: [], timeoutMinutes: 20, run: "bun run lint" },
        { key: "test", name: "Tests", needs: ["lint"], timeoutMinutes: 30, run: "bun install\nbun test\n" },
      ],
      required: ["test"],
      egressAllowlist: ["*.example.com", "pkg.example.org"],
    });
    expect(parseCiPipeline("version: 1\njobs:\n  a:\n    run: x\n  b:\n    run: y\n")?.required).toEqual([
      "a",
      "b",
    ]);
    expect(parseCiPipeline("version: 1\njobs:\n  a:\n    run: x\nrequired: []\n")?.required).toEqual([]);
  });

  it("treats a blank source as disabled CI", () => {
    expect(parseCiPipeline("  \n")).toBeNull();
  });

  it("names the first problem for each rule", () => {
    const job = (body: string) => `version: 1\njobs:\n  test:\n${body}`;

    expect(detail("version: 2\njobs:\n  a:\n    run: x\n")).toBe("version: must be 1");
    expect(detail("version: 1\njobs: {}\n")).toBe("jobs: 1 to 10 jobs");
    expect(detail(job("    run: x\n    image: alpine\n"))).toBe("jobs.test.image: unknown key");
    expect(detail(job("    name: x\n"))).toBe("jobs.test.run: required");
    expect(detail(job("    run: x\n    timeout_minutes: 61\n"))).toBe(
      "jobs.test.timeout_minutes: a whole number from 1 to 60",
    );
    expect(detail(job("    run: x\n    needs: [build]\n"))).toBe('jobs.test.needs: unknown job "build"');
    expect(detail(job("    run: x\n    needs: [test]\n"))).toBe("jobs.test.needs: a job cannot need itself");
    expect(
      detail("version: 1\njobs:\n  a:\n    run: x\n    needs: [b]\n  b:\n    run: y\n    needs: [a]\n"),
    ).toBe("jobs.a.needs: jobs need each other in a cycle");
    expect(detail("version: 1\njobs:\n  Bad:\n    run: x\n")).toMatch(/^jobs\.Bad: job keys/);
    expect(detail("version: 1\njobs:\n  a:\n    run: x\nrequired: [b]\n")).toBe('required: unknown job "b"');
    expect(detail("version: 1\njobs:\n  a:\n    run: x\negress_allowlist: ['https://x.com']\n")).toBe(
      'egress_allowlist: "https://x.com" is not a host or *.host',
    );
    expect(detail("version: 1\nbranches: [main]\njobs:\n  a:\n    run: x\n")).toBe("branches: unknown key");
    expect(detail("version: 1\njobs:\n  a: &x\n    run: x\n  b: *x\n")).toMatch(/^not valid YAML/);
    expect(detail(`version: 1\njobs:\n  a:\n    run: "${"x".repeat(70_000)}"\n`)).toBe(
      "the pipeline is larger than 64 KiB",
    );
  });
});
