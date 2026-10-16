import { TempoError } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import { parseProfile } from "../src/index.ts";

const detail = (source: string): string | undefined => {
  try {
    parseProfile(source);
  } catch (e) {
    if (e instanceof TempoError && e.code === "PROFILE_INVALID") return e.detail;
    throw e;
  }

  return undefined;
};

describe("parseProfile (13, L-ADR-3)", () => {
  it("reads every key with its defaults", () => {
    const spec = parseProfile(
      [
        "version: 1",
        "stack:",
        "  runtime: bun 1.3",
        "  frameworks: [TanStack Start]",
        "services:",
        "  - name: stripe",
        "    purpose: Payments",
        "    hosts: [api.stripe.com]",
        "    credential: STRIPE_KEY",
        "    methods: [GET, POST]",
        "checks:",
        "  - name: typecheck",
        "    command: bun run typecheck",
        "screens:",
        "  - route: /todos",
        "    files: ['src/routes/todos/**']",
        "notes: Keep copy short.",
      ].join("\n"),
    );

    expect(spec).toEqual({
      stack: { runtime: "bun 1.3", packageManager: null, frameworks: ["TanStack Start"], libraries: [] },
      services: [
        {
          name: "stripe",
          purpose: "Payments",
          hosts: ["api.stripe.com"],
          credential: "STRIPE_KEY",
          methods: ["GET", "POST"],
        },
      ],
      checks: [{ name: "typecheck", command: "bun run typecheck", timeoutMinutes: 10 }],
      screens: [{ route: "/todos", files: ["src/routes/todos/**"] }],
      notes: "Keep copy short.",
    });
    expect(parseProfile(" \n")).toBeNull();
  });

  it("names the first problem", () => {
    expect(detail("version: 2\n")).toBe("version: must be 1");
    expect(detail("version: 1\nteam: x\n")).toBe("team: unknown key");
    expect(detail("version: 1\nservices:\n  - name: s\n    purpose: p\n    hosts: []\n")).toBe(
      "services[0].hosts: 1 to 20 host patterns",
    );
    expect(
      detail("version: 1\nservices:\n  - name: s\n    purpose: p\n    hosts: [a.dev]\n    credential: key\n"),
    ).toBe("services[0].credential: an environment secret name such as STRIPE_KEY");
    expect(
      detail(
        "version: 1\nservices:\n  - name: s\n    purpose: p\n    hosts: [a.dev]\n    methods: [FETCH]\n",
      ),
    ).toMatch(/^services\[0\].methods: use GET/);
    expect(detail("version: 1\nchecks:\n  - name: t\n    command: x\n  - name: t\n    command: y\n")).toBe(
      'checks: duplicate "t"',
    );
    expect(detail("version: 1\nchecks:\n  - name: t\n    command: x\n    timeout_minutes: 31\n")).toBe(
      "checks[0].timeout_minutes: a whole number from 1 to 30",
    );
    expect(detail("version: 1\nscreens:\n  - route: todos\n    files: [a]\n")).toBe(
      "screens[0].route: must start with /",
    );
    expect(detail(`version: 1\nnotes: "${"x\\n".repeat(41)}"\n`)).toBe("notes: at most 40 lines and 4 KiB");
  });
});
