import {
  AGENT_IDS,
  DEFAULT_SETTINGS,
  Settings,
  SettingsLayer,
  type AgentId,
  type SettingsReadResult,
  type SettingsSource,
} from "@tempo/protocol";
import { Schema } from "effect";
import { parse as parseToml } from "smol-toml";

/** Settings files, as read from the workspace branch (01, Project settings file). */
export interface SettingsFiles {
  readonly tempoToml?: string | null;
  readonly conductorToml?: string | null;
  readonly conductorJson?: string | null;
}

export const SETTINGS_PATHS = {
  tempoToml: ".tempo/settings.toml",
  conductorToml: ".conductor/settings.toml",
  conductorJson: "conductor.json",
} as const;

type Obj = Record<string, unknown>;
const isObj = (u: unknown): u is Obj => typeof u === "object" && u !== null && !Array.isArray(u);

/** Known keys of a Tempo layer. `*` means any key; a nested object describes its children. */
const KNOWN: Obj = {
  agent: { default: true, models: { claude: true, codex: true, opencode: true, pi: true } },
  browser: { run: true },
  scripts: {
    setup: true,
    archive: true,
    run_mode: true,
    auto_run_after_setup: true,
    run: { "*": { command: true, cwd: true, default: true } },
  },
  environment: {
    instance: true,
    sleep_after_idle_minutes: true,
    egress_policy: true,
    egress_allowlist: true,
  },
  environment_variables: { "*": true },
  git: { branch_prefix: true, delete_branch_on_archive: true, archive_on_merge: true },
  prompts: { general: true },
};

const unknownKeys = (value: unknown, shape: unknown, path: string, out: string[]): void => {
  if (!isObj(value) || !isObj(shape)) return;
  for (const [k, v] of Object.entries(value)) {
    const child = k in shape ? shape[k] : shape["*"];
    const p = path ? `${path}.${k}` : k;
    if (child === undefined) out.push(p);
    else if (child !== true) unknownKeys(v, child, p, out);
  }
};

const decodeLayer = Schema.decodeUnknownExit(SettingsLayer);

interface LayerResult {
  readonly layer: SettingsLayer | null;
  readonly warnings: string[];
  readonly errors: string[];
}

const validate = (file: string, raw: unknown, warnings: string[]): LayerResult => {
  const unknown: string[] = [];
  unknownKeys(raw, KNOWN, "", unknown);
  for (const key of unknown) warnings.push(`${file}: unknown key "${key}" was ignored`);
  const exit = decodeLayer(raw);
  if (exit._tag === "Failure") {
    return { layer: null, warnings, errors: [`${file}: ${describeCause(exit.cause)}; the file was ignored`] };
  }
  return { layer: exit.value, warnings, errors: [] };
};

const describeCause = (cause: unknown): string => {
  const text = String((cause as { toString?: () => string })?.toString?.() ?? cause);
  return text.split("\n").slice(0, 6).join(" ").replace(/\s+/g, " ").trim() || "invalid settings";
};

const parseTomlSafe = (file: string, text: string): { value: unknown } | { error: string } => {
  try {
    return { value: parseToml(text) };
  } catch (e) {
    return {
      error: `${file}: ${e instanceof Error ? e.message.split("\n")[0] : "parse error"}; the file was ignored`,
    };
  }
};

export const readTempoToml = (text: string): LayerResult => {
  const file = SETTINGS_PATHS.tempoToml;
  const parsed = parseTomlSafe(file, text);
  if ("error" in parsed) return { layer: null, warnings: [], errors: [parsed.error] };
  return validate(file, parsed.value, []);
};

const CONDUCTOR_IGNORED_NOTE = "Conductor keys that Tempo ignores";

/** Maps `.conductor/settings.toml` to a Tempo layer (01, Conductor mapping). */
export const readConductorToml = (text: string): LayerResult => {
  const file = SETTINGS_PATHS.conductorToml;
  const parsed = parseTomlSafe(file, text);
  if ("error" in parsed) return { layer: null, warnings: [], errors: [parsed.error] };
  const raw = parsed.value;
  if (!isObj(raw))
    return { layer: null, warnings: [], errors: [`${file}: not a table; the file was ignored`] };
  const ignored: string[] = [];
  const out: Obj = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "scripts" && isObj(v)) {
      const scripts: Obj = {};
      for (const [sk, sv] of Object.entries(v)) {
        if (["setup", "archive", "run_mode", "auto_run_after_setup"].includes(sk)) scripts[sk] = sv;
        else if (sk === "run" && isObj(sv)) {
          const run: Obj = {};
          for (const [id, def] of Object.entries(sv)) {
            if (!isObj(def)) {
              ignored.push(`scripts.run.${id}`);
              continue;
            }
            const args = Array.isArray(def["args"]) ? def["args"].map(String) : [];
            const command = [String(def["command"] ?? ""), ...args].filter((s) => s !== "").join(" ");
            const entry: Obj = { command };
            const options = def["options"];
            if (isObj(options) && typeof options["cwd"] === "string") entry["cwd"] = options["cwd"];
            if (typeof def["default"] === "boolean") entry["default"] = def["default"];
            for (const dk of Object.keys(def)) {
              if (!["command", "args", "options", "default"].includes(dk))
                ignored.push(`scripts.run.${id}.${dk}`);
            }
            if (isObj(options)) {
              for (const ok of Object.keys(options))
                if (ok !== "cwd") ignored.push(`scripts.run.${id}.options.${ok}`);
            }
            run[id] = entry;
          }
          scripts["run"] = run;
        } else ignored.push(`scripts.${sk}`);
      }
      out["scripts"] = scripts;
    } else if (k === "environment_variables" && isObj(v)) {
      const cloud = v["cloud"];
      if (isObj(cloud)) out["environment_variables"] = stringRecord(cloud);
      else out["environment_variables"] = stringRecord(v);
    } else if (k === "prompts" && isObj(v)) {
      if ("general" in v) out["prompts"] = { general: v["general"] };
      for (const pk of Object.keys(v)) if (pk !== "general") ignored.push(`prompts.${pk}`);
    } else if (k === "git" && isObj(v)) {
      const git: Obj = {};
      for (const [gk, gv] of Object.entries(v)) {
        if (["branch_prefix", "delete_branch_on_archive", "archive_on_merge"].includes(gk)) git[gk] = gv;
        else ignored.push(`git.${gk}`);
      }
      out["git"] = git;
    } else ignored.push(k);
  }
  const warnings = ignored.length ? [`${file}: ${CONDUCTOR_IGNORED_NOTE}: ${ignored.join(", ")}`] : [];
  return validate(file, out, warnings);
};

const stringRecord = (o: Obj): Obj => {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o))
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  return out;
};

/** Maps `conductor.json` to a Tempo layer (01, Conductor mapping). */
export const readConductorJson = (text: string): LayerResult => {
  const file = SETTINGS_PATHS.conductorJson;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      layer: null,
      warnings: [],
      errors: [`${file}: ${e instanceof Error ? e.message : "parse error"}; the file was ignored`],
    };
  }
  if (!isObj(raw))
    return { layer: null, warnings: [], errors: [`${file}: not an object; the file was ignored`] };
  const ignored: string[] = [];
  const scripts: Obj = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "scripts" && isObj(v)) {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk === "setup" || sk === "archive") scripts[sk] = sv;
        else if (sk === "run" && typeof sv === "string")
          scripts["run"] = { default: { command: sv, default: true } };
        else ignored.push(`scripts.${sk}`);
      }
    } else if (k === "runScriptMode") scripts["run_mode"] = v;
    else ignored.push(k);
  }
  const warnings = ignored.length ? [`${file}: ${CONDUCTOR_IGNORED_NOTE}: ${ignored.join(", ")}`] : [];
  return validate(file, Object.keys(scripts).length ? { scripts } : {}, warnings);
};

type Sources = Record<string, SettingsSource>;

const setSource = (sources: Sources, path: string, source: SettingsSource) => {
  sources[path] = source;
};

/** Applies `layer` over `base`, recording where each leaf came from. */
const apply = (base: Settings, layer: SettingsLayer, source: SettingsSource, sources: Sources): Settings => {
  const next = structuredClone(base) as {
    -readonly [K in keyof Settings]: { -readonly [P in keyof Settings[K]]: Settings[K][P] };
  };
  const leaf = <S extends keyof Settings>(section: S, key: keyof Settings[S] & string, value: unknown) => {
    if (value === undefined) return;
    (next[section] as Record<string, unknown>)[key] = value;
    setSource(sources, `${section}.${key}`, source);
  };
  if (layer.agent) {
    leaf("agent", "default", layer.agent.default);
    const models = layer.agent.models;
    if (models) {
      const nextModels: Record<AgentId, string> = { ...next.agent.models };
      for (const agent of AGENT_IDS) {
        const model = models[agent];
        if (model === undefined) continue;
        nextModels[agent] = model;
        setSource(sources, `agent.models.${agent}`, source);
      }
      next.agent.models = nextModels;
    }
  }
  if (layer.browser) leaf("browser", "run", layer.browser.run);
  if (layer.scripts) {
    const s = layer.scripts;
    leaf("scripts", "setup", s.setup);
    leaf("scripts", "archive", s.archive);
    leaf("scripts", "run_mode", s.run_mode);
    leaf("scripts", "auto_run_after_setup", s.auto_run_after_setup);
    if (s.run) {
      const run = { ...next.scripts.run };
      for (const [id, def] of Object.entries(s.run)) {
        run[id] = { command: def.command, cwd: def.cwd ?? "", default: def.default ?? false };
        setSource(sources, `scripts.run.${id}`, source);
      }
      next.scripts.run = run;
    }
  }
  if (layer.environment) {
    const e = layer.environment;
    leaf("environment", "instance", e.instance);
    leaf("environment", "sleep_after_idle_minutes", e.sleep_after_idle_minutes);
    leaf("environment", "egress_policy", e.egress_policy);
    leaf("environment", "egress_allowlist", e.egress_allowlist);
  }
  if (layer.environment_variables) {
    const vars = { ...next.environment_variables };
    for (const [k, v] of Object.entries(layer.environment_variables)) {
      vars[k] = v;
      setSource(sources, `environment_variables.${k}`, source);
    }
    next.environment_variables = vars;
  }
  if (layer.git) {
    leaf("git", "branch_prefix", layer.git.branch_prefix);
    leaf("git", "delete_branch_on_archive", layer.git.delete_branch_on_archive);
    leaf("git", "archive_on_merge", layer.git.archive_on_merge);
  }
  if (layer.prompts) leaf("prompts", "general", layer.prompts.general);
  return next;
};

const decodeSettings = Schema.decodeUnknownExit(Settings);

/**
 * Computes effective settings. Precedence, highest first: UI overrides, `.tempo/settings.toml`,
 * `.conductor/settings.toml`, `conductor.json`, defaults.
 */
export const resolveSettings = (overrides: SettingsLayer, files: SettingsFiles): SettingsReadResult => {
  const warnings: string[] = [];
  const errors: string[] = [];
  const layers: Array<[SettingsSource, SettingsLayer]> = [];
  const add = (source: SettingsSource, text: string | null | undefined, read: (t: string) => LayerResult) => {
    if (text === null || text === undefined) return;
    const r = read(text);
    warnings.push(...r.warnings);
    errors.push(...r.errors);
    if (r.layer) layers.push([source, r.layer]);
  };
  add("conductor.json", files.conductorJson, readConductorJson);
  add(".conductor", files.conductorToml, readConductorToml);
  add(".tempo", files.tempoToml, readTempoToml);
  const sources: Sources = {};
  let effective: Settings = DEFAULT_SETTINGS;
  for (const [source, layer] of layers) effective = apply(effective, layer, source, sources);
  const withOverrides = apply(effective, overrides, "tempo", sources);
  const final = decodeSettings(withOverrides);
  if (final._tag === "Failure") {
    errors.push(`Project overrides: ${describeCause(final.cause)}; they were ignored`);
    for (const key of Object.keys(sources)) if (sources[key] === "tempo") delete sources[key];
    return { effective, warnings, errors, sources };
  }
  return { effective: final.value, warnings, errors, sources };
};

/** Validates UI overrides on their own (updateProjectSettings). */
export const validateOverrides = (
  raw: unknown,
): { ok: true; value: SettingsLayer } | { ok: false; error: string } => {
  const unknown: string[] = [];
  unknownKeys(raw, KNOWN, "", unknown);
  if (unknown.length) return { ok: false, error: `Unknown keys: ${unknown.join(", ")}` };
  const exit = decodeLayer(raw);
  if (exit._tag === "Failure") return { ok: false, error: describeCause(exit.cause) };
  const merged = decodeSettings(apply(DEFAULT_SETTINGS, exit.value, "tempo", {}));
  if (merged._tag === "Failure") return { ok: false, error: describeCause(merged.cause) };
  return { ok: true, value: exit.value };
};

export const defaultRunScriptId = (settings: Settings): string | null => {
  const entries = Object.entries(settings.scripts.run);
  return entries.find(([, s]) => s.default)?.[0] ?? null;
};
