import { DEFAULT_SETTINGS } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import {
  BROWSER_RUN_ALLOWLIST_WARNING,
  browserRunOn,
  resolveSettings,
  validateOverrides,
} from "../src/index.ts";

describe("resolveSettings", () => {
  it("returns defaults with no files", () => {
    const r = resolveSettings({}, {});
    expect(r.effective).toEqual(DEFAULT_SETTINGS);
    expect(r.errors).toEqual([]);
  });

  it("applies precedence: overrides > .tempo > defaults", () => {
    const r = resolveSettings(
      { scripts: { setup: "ui" } },
      { tempoYaml: `scripts:\n  setup: tempo\n  archive: t-archive\n` },
    );
    expect(r.effective.scripts.setup).toBe("ui");
    expect(r.effective.scripts.archive).toBe("t-archive");
    expect(r.effective.scripts.run_mode).toBe(DEFAULT_SETTINGS.scripts.run_mode);
    expect(r.sources?.["scripts.setup"]).toBe("tempo");
    expect(r.sources?.["scripts.archive"]).toBe(".tempo");
    expect(r.sources?.["scripts.run_mode"]).toBeUndefined();
  });

  it("ignores a file that fails to parse and reports it", () => {
    const r = resolveSettings({}, { tempoYaml: "scripts: [\nsetup:" });
    expect(r.effective).toEqual(DEFAULT_SETTINGS);
    expect(r.errors[0]).toContain(".tempo/settings.yaml");
  });

  it("ignores a file that fails validation", () => {
    const r = resolveSettings({}, { tempoYaml: `environment:\n  sleep_after_idle_minutes: 1\n` });
    expect(r.effective.environment.sleep_after_idle_minutes).toBe(15);
    expect(r.errors).toHaveLength(1);
  });

  it("merges agent.models per agent and tracks each one's source (01, [agent.models])", () => {
    const r = resolveSettings(
      { agent: { models: { pi: "openrouter/pi-ui" } } },
      {
        tempoYaml: `agent:\n  default: opencode\n  models:\n    opencode: openrouter/oc\n    pi: openrouter/pi-file\n`,
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
    const r = resolveSettings({}, { tempoYaml: `browser:\n  run: true\n` });
    expect(r.effective.browser.run).toBe(true);
    expect(r.sources?.["browser.run"]).toBe(".tempo");
    expect(
      resolveSettings({ browser: { run: false } }, { tempoYaml: `browser:\n  run: true\n` }).effective.browser
        .run,
    ).toBe(false);
  });

  it("turns Browser Run off under the allowlist egress policy, with a warning (01)", () => {
    const open = resolveSettings({}, { tempoYaml: `browser:\n  run: true\n` });
    expect(browserRunOn(open.effective)).toBe(true);
    expect(open.warnings).not.toContain(BROWSER_RUN_ALLOWLIST_WARNING);
    const allow = resolveSettings(
      { environment: { egress_policy: "allowlist" } },
      { tempoYaml: `browser:\n  run: true\n` },
    );
    expect(browserRunOn(allow.effective)).toBe(false);
    expect(allow.warnings).toContain(BROWSER_RUN_ALLOWLIST_WARNING);
    expect(resolveSettings({ environment: { egress_policy: "allowlist" } }, {}).warnings).toEqual([]);
  });

  it("reads an empty file as no settings", () => {
    const r = resolveSettings({}, { tempoYaml: "" });
    expect(r.errors).toEqual([]);
    expect(r.effective).toEqual(DEFAULT_SETTINGS);
  });

  it("treats the old agent.model key as unknown", () => {
    const r = resolveSettings({}, { tempoYaml: `agent:\n  model: x\n` });
    expect(r.warnings.join()).toContain("agent.model");
    expect(r.effective.agent.models).toEqual(DEFAULT_SETTINGS.agent.models);
  });

  it("warns on unknown keys", () => {
    const r = resolveSettings({}, { tempoYaml: `scripts:\n  setup: x\n  foo: 1\n` });
    expect(r.effective.scripts.setup).toBe("x");
    expect(r.warnings.join()).toContain("scripts.foo");
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
