import { DEFAULT_SETTINGS, SettingsLayer, type Settings, type JsonDataFields } from "@tempo/protocol";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  effectiveEntries,
  effectiveLeaf,
  FIELDS,
  fieldDef,
  formatValue,
  formFromLayer,
  formSignature,
  fromEdit,
  getAt,
  isSecretName,
  layerFromForm,
  sameLayer,
  SECTIONS,
  sourceLabel,
  toEdit,
  type SettingsForm,
} from "~/ui/components/dialogs/settings-model";

const effective: Settings = {
  ...DEFAULT_SETTINGS,
  scripts: {
    ...DEFAULT_SETTINGS.scripts,
    setup: "bun install",
    run: { dev: { command: "bun run dev", cwd: "", default: true } },
  },
  environment_variables: { NODE_ENV: "development" },
};

describe("the field list", () => {
  it("covers every settings key exactly once", () => {
    const leaves = (o: JsonDataFields, prefix = ""): string[] =>
      Object.entries(o).flatMap(([k, v]) => {
        const path = prefix ? `${prefix}.${k}` : k;

        if (path === "scripts.run" || path === "environment_variables") return [path];

        return Schema.is(Schema.JsonObject)(v) ? leaves(v, path) : [path];
      });

    expect(FIELDS.map((f) => f.path).sort()).toEqual(leaves(DEFAULT_SETTINGS).sort());
    expect(SECTIONS).toEqual(["Agent", "Browser", "Scripts", "Environment", "Git", "Prompts", "Roles"]);
  });

  it("has one free-text default model per agent and a Browser Run toggle (04, Settings → Project)", () => {
    expect(
      FIELDS.filter((f) => f.path.startsWith("agent.models.")).map((f) => [f.path, f.kind, f.label]),
    ).toEqual([
      ["agent.models.claude", "text", "Claude default model"],
      ["agent.models.codex", "text", "Codex default model"],
      ["agent.models.opencode", "text", "OpenCode default model"],
      ["agent.models.pi", "text", "Pi default model"],
    ]);
    expect(fieldDef("browser.run")).toMatchObject({ section: "Browser", label: "Browser Run", kind: "bool" });
  });
});

describe("toEdit and fromEdit", () => {
  it("round-trips each kind", () => {
    for (const def of FIELDS) {
      const value = getAt(effective, def.path);
      const parsed = fromEdit(def, toEdit(def, value));
      expect(parsed.ok, def.path).toBe(true);

      if (!parsed.ok) continue;

      if (def.kind === "run") {
        expect(parsed.value).toEqual({ dev: { command: "bun run dev", default: true } });
      } else {
        expect(parsed.value, def.path).toEqual(value);
      }
    }
  });

  it("checks sleep minutes (5 to 240, whole)", () => {
    const def = fieldDef("environment.sleep_after_idle_minutes");
    expect(fromEdit(def, { kind: "text", text: "30" })).toEqual({ ok: true, value: 30 });
    expect(fromEdit(def, { kind: "text", text: "4" }).ok).toBe(false);
    expect(fromEdit(def, { kind: "text", text: "241" }).ok).toBe(false);
    expect(fromEdit(def, { kind: "text", text: "7.5" }).ok).toBe(false);
    expect(fromEdit(def, { kind: "text", text: "" }).ok).toBe(false);
  });

  it("lowercases and checks host patterns", () => {
    const def = fieldDef("environment.egress_allowlist");
    expect(fromEdit(def, { kind: "text", text: "Example.com\n\n*.npmjs.org " })).toEqual({
      ok: true,
      value: ["example.com", "*.npmjs.org"],
    });
    const bad = fromEdit(def, { kind: "text", text: "ok.com\nhttps://x.com" });
    expect(bad).toEqual({ ok: false, error: "Not a host pattern: https://x.com" });
  });

  it("checks a custom instance against the schema", () => {
    const def = fieldDef("environment.instance");
    expect(
      fromEdit(def, {
        kind: "instance",
        instance: { preset: "standard-4", vcpu: "", memoryMib: "", diskMb: "" },
      }),
    ).toEqual({
      ok: true,
      value: "standard-4",
    });
    const custom = { preset: "custom" as const, vcpu: "2", memoryMib: "8192", diskMb: "10000" };
    expect(fromEdit(def, { kind: "instance", instance: custom })).toEqual({
      ok: true,
      value: { vcpu: 2, memoryMib: 8192, diskMb: 10000 },
    });
    expect(fromEdit(def, { kind: "instance", instance: { ...custom, memoryMib: "4096" } }).ok).toBe(false);
    expect(fromEdit(def, { kind: "instance", instance: { ...custom, vcpu: "x" } }).ok).toBe(false);
    expect(toEdit(def, { vcpu: 1, memoryMib: 4096, diskMb: 5 })).toEqual({
      kind: "instance",
      instance: { preset: "custom", vcpu: "1", memoryMib: "4096", diskMb: "5" },
    });
  });

  it("checks run script and variable rows", () => {
    const run = fieldDef("scripts.run");
    const row = { key: 1, id: "dev", command: "bun dev", cwd: " web ", isDefault: false };
    expect(fromEdit(run, { kind: "run", rows: [row] })).toEqual({
      ok: true,
      value: { dev: { command: "bun dev", cwd: "web" } },
    });
    expect(fromEdit(run, { kind: "run", rows: [{ ...row, id: " " }] }).ok).toBe(false);
    expect(fromEdit(run, { kind: "run", rows: [row, { ...row, key: 2 }] })).toEqual({
      ok: false,
      error: "Two run scripts are named dev.",
    });
    expect(fromEdit(run, { kind: "run", rows: [{ ...row, command: "" }] }).ok).toBe(false);

    const env = fieldDef("environment_variables");
    expect(fromEdit(env, { kind: "env", rows: [{ key: 1, name: " A ", value: "1" }] })).toEqual({
      ok: true,
      value: { A: "1" },
    });
    expect(fromEdit(env, { kind: "env", rows: [{ key: 1, name: "", value: "1" }] }).ok).toBe(false);
  });

  it("only accepts listed options for a select", () => {
    const def = fieldDef("scripts.run_mode");
    expect(fromEdit(def, { kind: "text", text: "nonconcurrent" })).toEqual({
      ok: true,
      value: "nonconcurrent",
    });
    expect(fromEdit(def, { kind: "text", text: "sometimes" }).ok).toBe(false);
  });
});

describe("the form", () => {
  const layer: SettingsLayer = {
    environment: { sleep_after_idle_minutes: 30 },
    scripts: { run: { web: { command: "bun web" } } },
  };

  it("marks only the project's own keys as set, and starts other leaves from the value in effect", () => {
    const form = formFromLayer(layer, effective);
    expect(form["environment.sleep_after_idle_minutes"]).toEqual({
      set: true,
      value: { kind: "text", text: "30" },
    });
    expect(form["scripts.setup"]).toEqual({ set: false, value: { kind: "text", text: "bun install" } });
    expect(form["environment_variables"].set).toBe(false);
    expect(form["environment_variables"].value).toEqual({ kind: "env", rows: [] });
    const run = form["scripts.run"].value;
    expect(run.kind === "run" && run.rows.map((r) => r.id)).toEqual(["web"]);
  });

  it("saves the same layer it was given", () => {
    const { layer: out, errors } = layerFromForm(formFromLayer(layer, effective));
    expect(errors).toEqual({});
    expect(sameLayer(out, layer)).toBe(true);
  });

  it("adds a key when it is set, drops it when it is unset, and reports bad fields", () => {
    const form = formFromLayer(layer, effective);

    const next: SettingsForm = {
      ...form,
      "git.branch_prefix": { set: true, value: { kind: "text", text: " me/ " } },
      "environment.sleep_after_idle_minutes": { ...form["environment.sleep_after_idle_minutes"], set: false },
    };

    expect(layerFromForm(next).layer).toEqual({
      git: { branch_prefix: "me/" },
      scripts: { run: { web: { command: "bun web" } } },
    });

    const bad: SettingsForm = {
      ...form,
      "environment.sleep_after_idle_minutes": { set: true, value: { kind: "text", text: "1" } },
    };

    expect(Object.keys(layerFromForm(bad).errors)).toEqual(["environment.sleep_after_idle_minutes"]);
  });

  it("saves agent models and Browser Run as a SettingsLayer", () => {
    const form = formFromLayer({ agent: { models: { codex: "gpt-5-codex" } } }, effective);
    expect(form["agent.models.codex"]).toEqual({ set: true, value: { kind: "text", text: "gpt-5-codex" } });
    expect(form["agent.models.pi"]).toEqual({ set: false, value: { kind: "text", text: "" } });
    expect(form["browser.run"]).toEqual({ set: false, value: { kind: "bool", on: false } });

    const next: SettingsForm = {
      ...form,
      "agent.models.pi": { set: true, value: { kind: "text", text: " openrouter/pi " } },
      "browser.run": { set: true, value: { kind: "bool", on: true } },
    };

    const { layer: out, errors } = layerFromForm(next);
    expect(errors).toEqual({});
    expect(out).toEqual({
      agent: { models: { codex: "gpt-5-codex", pi: "openrouter/pi" } },
      browser: { run: true },
    });
    expect(Schema.decodeUnknownSync(SettingsLayer)(out)).toEqual(out);
  });

  it("detects changes but not new row keys", () => {
    const a = formFromLayer(layer, effective);
    const b = formFromLayer(layer, effective);
    expect(formSignature(a)).toBe(formSignature(b));
    expect(
      formSignature({ ...a, "git.archive_on_merge": { set: true, value: { kind: "bool", on: true } } }),
    ).not.toBe(formSignature(a));
  });

  it("compares layers without regard to key order or undefined keys", () => {
    expect(sameLayer({ a: 1, b: { c: 2, d: undefined } }, { b: { c: 2 }, a: 1 })).toBe(true);
    expect(sameLayer({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });
});

describe("effective values and sources (04: Tempo, .tempo or default)", () => {
  const layer: SettingsLayer = { scripts: { setup: "make" } };

  it("uses the open workspace's values and sources", () => {
    const ctx = {
      settings: effective,
      sources: { "scripts.setup": ".tempo" as const, "scripts.run.dev": "default" as const },
      layer,
    };

    expect(effectiveLeaf(fieldDef("scripts.setup"), ctx)).toEqual({ text: "bun install", source: ".tempo" });
    expect(effectiveLeaf(fieldDef("git.branch_prefix"), ctx)).toEqual({ text: "tempo/", source: "default" });
    expect(effectiveEntries(fieldDef("scripts.run"), ctx)).toEqual([
      { key: "dev", text: "bun run dev · default", source: "default" },
    ]);
    expect(effectiveEntries(fieldDef("environment_variables"), ctx)).toEqual([
      { key: "NODE_ENV", text: "NODE_ENV=development", source: "default" },
    ]);
  });

  it("shows each agent's model and Browser Run with their sources", () => {
    const settings: Settings = {
      ...effective,
      agent: { default: "claude", models: { ...effective.agent.models, pi: "openrouter/pi" } },
      browser: { run: true },
    };

    const ctx = {
      settings,
      sources: { "agent.models.pi": ".tempo" as const, "browser.run": "tempo" as const },
      layer: { browser: { run: true } },
    };

    expect(effectiveLeaf(fieldDef("agent.models.pi"), ctx)).toEqual({
      text: "openrouter/pi",
      source: ".tempo",
    });
    expect(effectiveLeaf(fieldDef("agent.models.opencode"), ctx)).toEqual({
      text: "Empty",
      source: "default",
    });
    expect(effectiveLeaf(fieldDef("browser.run"), ctx)).toEqual({ text: "On", source: "tempo" });
    expect(effectiveLeaf(fieldDef("browser.run"), { settings: null, sources: null, layer: {} })).toEqual({
      text: "Off",
      source: "default",
    });
  });

  it("falls back to the project's overrides over the defaults with no open workspace", () => {
    const ctx = { settings: null, sources: null, layer };
    expect(effectiveLeaf(fieldDef("scripts.setup"), ctx)).toEqual({ text: "make", source: "tempo" });
    expect(effectiveLeaf(fieldDef("scripts.archive"), ctx)).toEqual({ text: "Empty", source: "default" });
    expect(effectiveLeaf(fieldDef("environment.instance"), ctx)).toEqual({
      text: "standard-3",
      source: "default",
    });
    expect(effectiveEntries(fieldDef("scripts.run"), ctx)).toEqual([]);
  });

  it("labels sources as 04 names them", () => {
    expect(sourceLabel("tempo")).toBe("Tempo");
    expect(sourceLabel("default")).toBe("default");
  });

  it("formats values for display", () => {
    expect(formatValue(fieldDef("git.archive_on_merge"), true)).toBe("On");
    expect(formatValue(fieldDef("git.archive_on_merge"), false)).toBe("Off");
    expect(formatValue(fieldDef("scripts.run_mode"), "nonconcurrent")).toBe("One at a time");
    expect(formatValue(fieldDef("environment.egress_allowlist"), [])).toBe("None");
    expect(formatValue(fieldDef("environment.egress_allowlist"), ["a.com", "b.com"])).toBe("a.com, b.com");
    expect(formatValue(fieldDef("agent.default"), "codex")).toBe("Codex");
  });
});

describe("project secret names (02: ^[A-Z_][A-Z0-9_]*$)", () => {
  it("accepts env-style names only", () => {
    expect(isSecretName("API_TOKEN")).toBe(true);
    expect(isSecretName("_X1")).toBe(true);
    expect(isSecretName("1X")).toBe(false);
    expect(isSecretName("api_token")).toBe(false);
    expect(isSecretName("A-B")).toBe(false);
    expect(isSecretName("")).toBe(false);
  });
});
