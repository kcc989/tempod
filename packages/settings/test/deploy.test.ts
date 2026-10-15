import { TempoError } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import { parseDeployConfig } from "../src/index.ts";

const isBranch = (branch: string) => !branch.includes("..") && !branch.startsWith("-");

const detail = (source: string): string | undefined => {
  try {
    parseDeployConfig(source, isBranch);
  } catch (e) {
    if (e instanceof TempoError && e.code === "DEPLOY_CONFIG_INVALID") return e.detail;
    throw e;
  }

  return undefined;
};

const base = "version: 1\ntool: alchemy\n";

describe("parseDeployConfig", () => {
  it("applies defaults, always grants workers and keeps target order", () => {
    const spec = parseDeployConfig(
      [
        "version: 1",
        "tool: cloudflare-config",
        "root: apps/web",
        "install: bun install --frozen-lockfile",
        "build: bun run build",
        "permissions: [r2, d1]",
        "timeout_minutes: 30",
        "egress_allowlist: ['pkg.example.com']",
        "targets:",
        "  production:",
        "    branch: main",
        "    stage: prod",
        "    auto: true",
        "  preview:",
        "    agent: true",
      ].join("\n"),
      isBranch,
    );

    expect(spec).toEqual({
      tool: "cloudflare-config",
      root: "apps/web",
      install: "bun install --frozen-lockfile",
      build: "bun run build",
      permissions: ["workers", "d1", "r2"],
      timeoutMinutes: 30,
      egressAllowlist: ["pkg.example.com"],
      targets: [
        {
          key: "production",
          stage: "prod",
          branch: "main",
          auto: true,
          agent: false,
          rollout: "full",
          workers: [],
          smoke: [],
        },
        {
          key: "preview",
          stage: "preview",
          branch: null,
          auto: false,
          agent: true,
          rollout: "full",
          workers: [],
          smoke: [],
        },
      ],
      autoFix: false,
    });
    expect(parseDeployConfig(`${base}targets:\n  live: {}\n`, isBranch)).toMatchObject({
      root: "",
      install: null,
      build: null,
      permissions: ["workers"],
      timeoutMinutes: 20,
    });
  });

  it("reads a gradual rollout with its Workers and smoke URLs (12, Gradual rollout)", () => {
    const spec = parseDeployConfig(
      `${base}targets:\n  live:\n    rollout: gradual\n    workers: [app-web, app-api]\n    smoke: ['https://app.example.com/health']\n`,
      isBranch,
    );

    expect(spec?.targets[0]).toMatchObject({
      rollout: "gradual",
      workers: ["app-web", "app-api"],
      smoke: ["https://app.example.com/health"],
    });
    expect(detail(`${base}targets:\n  a:\n    rollout: gradual\n`)).toBe(
      "targets.a.rollout: gradual needs workers",
    );
    expect(detail(`${base}targets:\n  a:\n    rollout: canary\n`)).toBe("targets.a.rollout: full or gradual");
    expect(detail(`${base}targets:\n  a:\n    workers: [App]\n`)).toBe(
      'targets.a.workers: "App" is not a Worker name',
    );
    expect(detail(`${base}targets:\n  a:\n    workers: [w]\n    smoke: ['https://x.dev']\n`)).toBe(
      "targets.a.smoke: needs rollout: gradual",
    );
    expect(
      detail(`${base}targets:\n  a:\n    rollout: gradual\n    workers: [w]\n    smoke: ['http://x.dev']\n`),
    ).toBe('targets.a.smoke: "http://x.dev" is not an https URL');
  });

  it("treats a blank source as disabled deploys", () => {
    expect(parseDeployConfig(" \n", isBranch)).toBeNull();
  });

  it("names the first problem for each rule", () => {
    expect(detail("version: 2\ntool: alchemy\ntargets:\n  a: {}\n")).toBe("version: must be 1");
    expect(detail("version: 1\ntool: wrangler\ntargets:\n  a: {}\n")).toBe(
      "tool: alchemy or cloudflare-config",
    );
    expect(detail(`${base}targets: {}\n`)).toBe("targets: 1 to 10 targets");
    expect(detail(`${base}image: x\ntargets:\n  a: {}\n`)).toBe("image: unknown key");
    expect(detail(`${base}permissions: [dns]\ntargets:\n  a: {}\n`)).toBe(
      'permissions: unknown permission "dns"',
    );
    expect(detail(`${base}root: ../x\ntargets:\n  a: {}\n`)).toMatch(/^root: a relative directory/);
    expect(detail(`${base}root: /abs\ntargets:\n  a: {}\n`)).toMatch(/^root: a relative directory/);
    expect(detail(`${base}install: '  '\ntargets:\n  a: {}\n`)).toBe("install: must be a nonempty string");
    expect(detail(`${base}timeout_minutes: 61\ntargets:\n  a: {}\n`)).toBe(
      "timeout_minutes: a whole number from 1 to 60",
    );
    expect(detail(`${base}egress_allowlist: ['http://x']\ntargets:\n  a: {}\n`)).toBe(
      'egress_allowlist: "http://x" is not a host or *.host',
    );
    expect(detail(`${base}targets:\n  Prod: {}\n`)).toMatch(/^targets.Prod: target keys use/);
    expect(detail(`${base}targets:\n  a:\n    stage: 'Bad Stage'\n`)).toMatch(/^targets.a.stage: use/);
    expect(detail(`${base}targets:\n  a:\n    branch: a..b\n`)).toBe(
      "targets.a.branch: not a valid branch name",
    );
    expect(detail(`${base}targets:\n  a:\n    auto: true\n`)).toBe("targets.a.auto: needs branch");
    expect(detail(`${base}targets:\n  a:\n    agent: 'yes'\n`)).toBe(
      "targets.a.agent: must be true or false",
    );
    expect(detail(`${base}targets:\n  a: {}\n${"#".repeat(16 * 1024)}`)).toBe(
      "the configuration is larger than 16 KiB",
    );
  });
});
