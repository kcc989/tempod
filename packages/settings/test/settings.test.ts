import { DEFAULT_SETTINGS } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import { readConductorJson, readConductorToml, resolveSettings, validateOverrides } from "../src/index.ts";

describe("resolveSettings", () => {
  it("returns defaults with no files", () => {
    const r = resolveSettings({}, {});
    expect(r.effective).toEqual(DEFAULT_SETTINGS);
    expect(r.errors).toEqual([]);
  });

  it("applies precedence: overrides > .tempo > .conductor > conductor.json", () => {
    const r = resolveSettings(
      { scripts: { setup: "ui" } },
      {
        tempoToml: `[scripts]\nsetup = "tempo"\narchive = "t-archive"\n`,
        conductorToml: `[scripts]\nsetup = "conductor"\narchive = "c-archive"\nrun_mode = "nonconcurrent"\n`,
        conductorJson: JSON.stringify({ scripts: { setup: "json", run: "npm run dev" }, runScriptMode: "concurrent" }),
      },
    );
    expect(r.effective.scripts.setup).toBe("ui");
    expect(r.effective.scripts.archive).toBe("t-archive");
    expect(r.effective.scripts.run_mode).toBe("nonconcurrent");
    expect(r.effective.scripts.run["default"]).toEqual({ command: "npm run dev", cwd: "", default: true });
    expect(r.sources?.["scripts.setup"]).toBe("tempo");
    expect(r.sources?.["scripts.archive"]).toBe(".tempo");
    expect(r.sources?.["scripts.run_mode"]).toBe(".conductor");
    expect(r.sources?.["scripts.run.default"]).toBe("conductor.json");
  });

  it("ignores a file that fails to parse and reports it", () => {
    const r = resolveSettings({}, { tempoToml: "[scripts\nsetup=", conductorToml: `[scripts]\nsetup = "c"\n` });
    expect(r.effective.scripts.setup).toBe("c");
    expect(r.errors[0]).toContain(".tempo/settings.toml");
  });

  it("ignores a file that fails validation", () => {
    const r = resolveSettings({}, { tempoToml: `[environment]\nsleep_after_idle_minutes = 1\n` });
    expect(r.effective.environment.sleep_after_idle_minutes).toBe(15);
    expect(r.errors).toHaveLength(1);
  });

  it("warns on unknown keys", () => {
    const r = resolveSettings({}, { tempoToml: `[scripts]\nsetup = "x"\nfoo = 1\n` });
    expect(r.effective.scripts.setup).toBe("x");
    expect(r.warnings.join()).toContain("scripts.foo");
  });
});

describe("Conductor mapping", () => {
  it("maps .conductor/settings.toml", () => {
    const r = readConductorToml(
      [
        "spotlight_testing = true",
        "[scripts]",
        'setup = "bun install"',
        "[scripts.run.web]",
        'command = "bun"',
        'args = ["run", "dev"]',
        "default = true",
        "[scripts.run.web.options]",
        'cwd = "apps/web"',
        "[environment_variables.cloud]",
        'API = "x"',
        "[git]",
        'branch_prefix = "me/"',
      ].join("\n"),
    );
    expect(r.errors).toEqual([]);
    expect(r.layer?.scripts?.run?.["web"]).toEqual({ command: "bun run dev", cwd: "apps/web", default: true });
    expect(r.layer?.environment_variables).toEqual({ API: "x" });
    expect(r.layer?.git?.branch_prefix).toBe("me/");
    expect(r.warnings[0]).toContain("spotlight_testing");
  });

  it("maps conductor.json", () => {
    const r = readConductorJson(JSON.stringify({ scripts: { setup: "a", archive: "b", run: "c" }, runScriptMode: "nonconcurrent", preview_urls: [] }));
    expect(r.layer?.scripts).toEqual({ setup: "a", archive: "b", run: { default: { command: "c", default: true } }, run_mode: "nonconcurrent" });
    expect(r.warnings[0]).toContain("preview_urls");
  });
});

describe("validateOverrides", () => {
  it("accepts a valid partial layer", () => {
    expect(validateOverrides({ environment: { instance: "standard-4" } }).ok).toBe(true);
  });
  it("rejects unknown keys and bad values", () => {
    expect(validateOverrides({ nope: 1 }).ok).toBe(false);
    expect(validateOverrides({ environment: { egress_policy: "closed" } }).ok).toBe(false);
    expect(validateOverrides({ environment: { instance: { vcpu: 4, memoryMib: 8192, diskMb: 10000 } } }).ok).toBe(false);
  });
});
