import { DEFAULT_SETTINGS } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import {
  BROWSER_RUN_ALLOWLIST_WARNING,
  browserRunOn,
  readConductorJson,
  readConductorToml,
  resolveSettings,
  validateOverrides,
} from "../src/index.ts";

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
        conductorJson: JSON.stringify({
          scripts: { setup: "json", run: "npm run dev" },
          runScriptMode: "concurrent",
        }),
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

  it("ignores egress keys in repo files, but not in Tempo overrides", () => {
    const toml = `[environment]\negress_policy = "open"\negress_allowlist = ["evil.example"]\ninstance = "standard-4"\n`;
    const r = resolveSettings({}, { tempoToml: toml });
    expect(r.effective.environment.egress_policy).toBe("allowlist");
    expect(r.effective.environment.egress_allowlist).toEqual([]);
    expect(r.effective.environment.instance).toBe("standard-4");
    expect(r.warnings.some((w) => w.includes("egress"))).toBe(true);
    const o = resolveSettings({ environment: { egress_policy: "open" } }, { tempoToml: toml });
    expect(o.effective.environment.egress_policy).toBe("open");
  });

  it("ignores a file that fails to parse and reports it", () => {
    const r = resolveSettings(
      {},
      { tempoToml: "[scripts\nsetup=", conductorToml: `[scripts]\nsetup = "c"\n` },
    );
    expect(r.effective.scripts.setup).toBe("c");
    expect(r.errors[0]).toContain(".tempo/settings.toml");
  });

  it("ignores a file that fails validation", () => {
    const r = resolveSettings({}, { tempoToml: `[environment]\nsleep_after_idle_minutes = 1\n` });
    expect(r.effective.environment.sleep_after_idle_minutes).toBe(15);
    expect(r.errors).toHaveLength(1);
  });

  it("merges agent.models per agent and tracks each one's source (01, [agent.models])", () => {
    const r = resolveSettings(
      { agent: { models: { pi: "openrouter/pi-ui" } } },
      {
        tempoToml: `[agent]\ndefault = "opencode"\n[agent.models]\nopencode = "openrouter/oc"\npi = "openrouter/pi-file"\n`,
      },
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.effective.agent).toEqual({
      default: "opencode",
      models: { claude: "", codex: "", opencode: "openrouter/oc", pi: "openrouter/pi-ui" },
    });
    expect(r.sources?.["agent.default"]).toBe(".tempo");
    expect(r.sources?.["agent.models.opencode"]).toBe(".tempo");
    expect(r.sources?.["agent.models.pi"]).toBe("tempo");
    expect(r.sources?.["agent.models.claude"]).toBeUndefined();
  });

  it("reads browser.run, off by default", () => {
    expect(resolveSettings({}, {}).effective.browser).toEqual({ run: false });
    const r = resolveSettings({}, { tempoToml: `[browser]\nrun = true\n` });
    expect(r.effective.browser.run).toBe(true);
    expect(r.sources?.["browser.run"]).toBe(".tempo");
    expect(
      resolveSettings({ browser: { run: false } }, { tempoToml: `[browser]\nrun = true\n` }).effective.browser
        .run,
    ).toBe(false);
  });

  it("turns Browser Run off under the allowlist egress policy, with a warning (01)", () => {
    const open = resolveSettings(
      { environment: { egress_policy: "open" } },
      { tempoToml: `[browser]\nrun = true\n` },
    );
    expect(browserRunOn(open.effective)).toBe(true);
    expect(open.warnings).not.toContain(BROWSER_RUN_ALLOWLIST_WARNING);
    const allow = resolveSettings(
      { environment: { egress_policy: "allowlist" } },
      { tempoToml: `[browser]\nrun = true\n` },
    );
    expect(browserRunOn(allow.effective)).toBe(false);
    expect(allow.warnings).toContain(BROWSER_RUN_ALLOWLIST_WARNING);
    expect(resolveSettings({ environment: { egress_policy: "allowlist" } }, {}).warnings).toEqual([]);
  });

  it("treats the old agent.model key as unknown", () => {
    const r = resolveSettings({}, { tempoToml: `[agent]\nmodel = "x"\n` });
    expect(r.warnings.join()).toContain("agent.model");
    expect(r.effective.agent.models).toEqual(DEFAULT_SETTINGS.agent.models);
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
    expect(r.layer?.scripts?.run?.["web"]).toEqual({
      command: "bun run dev",
      cwd: "apps/web",
      default: true,
    });
    expect(r.layer?.environment_variables).toEqual({ API: "x" });
    expect(r.layer?.git?.branch_prefix).toBe("me/");
    expect(r.warnings[0]).toContain("spotlight_testing");
  });

  it("maps conductor.json", () => {
    const r = readConductorJson(
      JSON.stringify({
        scripts: { setup: "a", archive: "b", run: "c" },
        runScriptMode: "nonconcurrent",
        preview_urls: [],
      }),
    );
    expect(r.layer?.scripts).toEqual({
      setup: "a",
      archive: "b",
      run: { default: { command: "c", default: true } },
      run_mode: "nonconcurrent",
    });
    expect(r.warnings[0]).toContain("preview_urls");
  });
});

describe("validateOverrides", () => {
  it("accepts a valid partial layer", () => {
    expect(validateOverrides({ environment: { instance: "standard-4" } }).ok).toBe(true);
    expect(validateOverrides({ agent: { models: { opencode: "a/b" } }, browser: { run: true } })).toEqual({
      ok: true,
      value: { agent: { models: { opencode: "a/b" } }, browser: { run: true } },
    });
  });
  it("rejects unknown keys and bad values", () => {
    expect(validateOverrides({ nope: 1 }).ok).toBe(false);
    expect(validateOverrides({ agent: { model: "x" } }).ok).toBe(false);
    expect(validateOverrides({ agent: { models: { gpt: "x" } } }).ok).toBe(false);
    expect(validateOverrides({ browser: { run: "on" } }).ok).toBe(false);
    expect(validateOverrides({ environment: { egress_policy: "closed" } }).ok).toBe(false);
    expect(
      validateOverrides({ environment: { instance: { vcpu: 4, memoryMib: 8192, diskMb: 10000 } } }).ok,
    ).toBe(false);
  });
});
