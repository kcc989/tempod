import {
  AGENT_IDS,
  AGENT_LABELS,
  CustomInstance,
  DEFAULT_SETTINGS,
  EnvName,
  HostPattern,
  SETTINGS_SOURCE_LABELS,
  instanceLabel,
  type Instance,
  type Settings,
  type SettingsLayer,
  type SettingsSource,
} from "@tempo/protocol";
import { Schema } from "effect";

/**
 * Settings → Project (04): every settings key as one field of a SettingsLayer form. A field is
 * either inherited (not in the layer) or set here (a Tempo override). Pure, so it is unit-tested.
 */

export type FieldKind =
  | "text"
  | "multiline"
  | "select"
  | "bool"
  | "number"
  | "hosts"
  | "instance"
  | "run"
  | "env";

export interface FieldOption {
  readonly value: string;
  readonly label: string;
}

export interface FieldDef {
  readonly path: string;
  readonly section: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly options?: ReadonlyArray<FieldOption>;
  readonly hint?: string;
}

export const INSTANCE_PRESETS = ["standard-2", "standard-3", "standard-4"] as const;

export const FIELDS = [
  {
    path: "agent.default",
    section: "Agent",
    label: "Default agent",
    kind: "select",
    options: AGENT_IDS.map((a) => ({ value: a, label: AGENT_LABELS[a] })),
  },
  {
    path: "agent.model",
    section: "Agent",
    label: "Model",
    kind: "text",
    hint: "The agent's model value. OpenCode and Pi need one.",
  },
  { path: "scripts.setup", section: "Scripts", label: "Setup script", kind: "multiline" },
  { path: "scripts.run", section: "Scripts", label: "Run scripts", kind: "run" },
  {
    path: "scripts.run_mode",
    section: "Scripts",
    label: "Run mode",
    kind: "select",
    options: [
      { value: "concurrent", label: "Concurrent" },
      { value: "nonconcurrent", label: "One at a time" },
    ],
  },
  {
    path: "scripts.auto_run_after_setup",
    section: "Scripts",
    label: "Start the default run script after setup",
    kind: "bool",
  },
  { path: "scripts.archive", section: "Scripts", label: "Archive script", kind: "multiline" },
  { path: "environment_variables", section: "Environment", label: "Environment variables", kind: "env" },
  { path: "environment.instance", section: "Environment", label: "Instance size", kind: "instance" },
  {
    path: "environment.sleep_after_idle_minutes",
    section: "Environment",
    label: "Sleep after idle (minutes)",
    kind: "number",
    hint: "5 to 240.",
  },
  {
    path: "environment.egress_policy",
    section: "Environment",
    label: "Egress policy",
    kind: "select",
    options: [
      { value: "open", label: "Open" },
      { value: "allowlist", label: "Allowlist" },
    ],
  },
  {
    path: "environment.egress_allowlist",
    section: "Environment",
    label: "Egress allowlist",
    kind: "hosts",
    hint: "One host per line. *.example.com is allowed.",
  },
  { path: "git.branch_prefix", section: "Git", label: "Branch prefix", kind: "text" },
  {
    path: "git.delete_branch_on_archive",
    section: "Git",
    label: "Delete the branch on archive",
    kind: "bool",
  },
  { path: "git.archive_on_merge", section: "Git", label: "Archive on merge", kind: "bool" },
  {
    path: "prompts.general",
    section: "Prompts",
    label: "General prompt",
    kind: "multiline",
    hint: "Added to the first prompt of every session.",
  },
] as const satisfies ReadonlyArray<FieldDef>;

export type FieldPath = (typeof FIELDS)[number]["path"];

export const SECTIONS: ReadonlyArray<string> = [...new Set(FIELDS.map((f) => f.section))];

export interface InstanceEdit {
  readonly preset: (typeof INSTANCE_PRESETS)[number] | "custom";
  readonly vcpu: string;
  readonly memoryMib: string;
  readonly diskMb: string;
}

export interface RunRow {
  /** React key; not saved. */
  readonly key: number;
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly isDefault: boolean;
}

export interface EnvRow {
  readonly key: number;
  readonly name: string;
  readonly value: string;
}

export type EditValue =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "bool"; readonly on: boolean }
  | { readonly kind: "instance"; readonly instance: InstanceEdit }
  | { readonly kind: "run"; readonly rows: ReadonlyArray<RunRow> }
  | { readonly kind: "env"; readonly rows: ReadonlyArray<EnvRow> };

export interface FieldState {
  /** True when the project sets this key itself (a Tempo override). */
  readonly set: boolean;
  readonly value: EditValue;
}

export type SettingsForm = Readonly<Record<FieldPath, FieldState>>;
export type FieldErrors = Partial<Record<FieldPath, string>>;

let rowSeq = 0;
export const nextRowKey = (): number => ++rowSeq;

const isObj = (u: unknown): u is Record<string, unknown> =>
  typeof u === "object" && u !== null && !Array.isArray(u);

export const getAt = (obj: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), obj);

const setAt = (obj: Record<string, unknown>, path: string, value: unknown): void => {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(o[k])) o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[keys[keys.length - 1]!] = value;
};

export const fieldDef = (path: FieldPath): FieldDef => FIELDS.find((f) => f.path === path)!;

const CUSTOM_START: Omit<InstanceEdit, "preset"> = { vcpu: "2", memoryMib: "8192", diskMb: "10000" };

/** A stored value as the field's editor value. */
export const toEdit = (def: FieldDef, value: unknown): EditValue => {
  switch (def.kind) {
    case "text":
    case "multiline":
    case "select":
      return { kind: "text", text: typeof value === "string" ? value : "" };
    case "number":
      return { kind: "text", text: typeof value === "number" ? String(value) : "" };
    case "hosts":
      return { kind: "text", text: Array.isArray(value) ? value.join("\n") : "" };
    case "bool":
      return { kind: "bool", on: value === true };
    case "instance": {
      if (typeof value === "string" && (INSTANCE_PRESETS as ReadonlyArray<string>).includes(value)) {
        return { kind: "instance", instance: { preset: value as InstanceEdit["preset"], ...CUSTOM_START } };
      }
      if (isObj(value)) {
        return {
          kind: "instance",
          instance: {
            preset: "custom",
            vcpu: String(value["vcpu"] ?? ""),
            memoryMib: String(value["memoryMib"] ?? ""),
            diskMb: String(value["diskMb"] ?? ""),
          },
        };
      }
      return { kind: "instance", instance: { preset: "standard-3", ...CUSTOM_START } };
    }
    case "run":
      return {
        kind: "run",
        rows: Object.entries(isObj(value) ? value : {}).map(([id, s]) => {
          const r = isObj(s) ? s : {};
          return {
            key: nextRowKey(),
            id,
            command: typeof r["command"] === "string" ? r["command"] : "",
            cwd: typeof r["cwd"] === "string" ? r["cwd"] : "",
            isDefault: r["default"] === true,
          };
        }),
      };
    case "env":
      return {
        kind: "env",
        rows: Object.entries(isObj(value) ? value : {}).map(([name, v]) => ({
          key: nextRowKey(),
          name,
          value: typeof v === "string" ? v : "",
        })),
      };
  }
};

type Parsed = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

const isHost = Schema.is(HostPattern);
const isCustomInstance = Schema.is(CustomInstance);
const WHOLE = /^\d+$/;

/** The editor value as a layer value, or the reason it is not valid. */
export const fromEdit = (def: FieldDef, edit: EditValue): Parsed => {
  switch (edit.kind) {
    case "text": {
      if (def.kind === "number") {
        const t = edit.text.trim();
        const n = Number(t);
        return WHOLE.test(t) && n >= 5 && n <= 240
          ? { ok: true, value: n }
          : { ok: false, error: "Use a whole number from 5 to 240." };
      }
      if (def.kind === "hosts") {
        const hosts = edit.text
          .split("\n")
          .map((l) => l.trim().toLowerCase())
          .filter((l) => l !== "");
        const bad = hosts.find((h) => !isHost(h));
        return bad === undefined
          ? { ok: true, value: hosts }
          : { ok: false, error: `Not a host pattern: ${bad}` };
      }
      if (def.kind === "select") {
        return def.options?.some((o) => o.value === edit.text)
          ? { ok: true, value: edit.text }
          : { ok: false, error: "Pick a value." };
      }
      return { ok: true, value: def.kind === "text" ? edit.text.trim() : edit.text };
    }
    case "bool":
      return { ok: true, value: edit.on };
    case "instance": {
      const i = edit.instance;
      if (i.preset !== "custom") return { ok: true, value: i.preset };
      const parts = [i.vcpu, i.memoryMib, i.diskMb].map((s) => s.trim());
      const [vcpu, memoryMib, diskMb] = parts.map(Number);
      const value = { vcpu, memoryMib, diskMb };
      return parts.every((p) => WHOLE.test(p)) && isCustomInstance(value)
        ? { ok: true, value }
        : {
            ok: false,
            error:
              "Use 1 to 4 vCPU, 4096 to 12288 MiB of memory (3072 MiB per vCPU at least) and 1 to 20000 MB of disk.",
          };
    }
    case "run": {
      const out: Record<string, { command: string; cwd?: string; default?: boolean }> = {};
      for (const r of edit.rows) {
        const id = r.id.trim();
        if (id === "") return { ok: false, error: "Each run script needs a name." };
        if (id in out) return { ok: false, error: `Two run scripts are named ${id}.` };
        if (r.command.trim() === "") return { ok: false, error: `Run script ${id} needs a command.` };
        out[id] = {
          command: r.command,
          ...(r.cwd.trim() ? { cwd: r.cwd.trim() } : {}),
          ...(r.isDefault ? { default: true } : {}),
        };
      }
      return { ok: true, value: out };
    }
    case "env": {
      const out: Record<string, string> = {};
      for (const r of edit.rows) {
        const name = r.name.trim();
        if (name === "") return { ok: false, error: "Each variable needs a name." };
        if (name in out) return { ok: false, error: `Two variables are named ${name}.` };
        out[name] = r.value;
      }
      return { ok: true, value: out };
    }
  }
};

const isRecordField = (def: FieldDef): boolean => def.kind === "run" || def.kind === "env";

/**
 * The form for a project's saved overrides. A field the project does not set starts from its
 * effective value, so editing starts from what is in use. Run scripts and variables
 * merge per entry with the repo files, so their editors hold only the project's own entries.
 */
export const formFromLayer = (layer: SettingsLayer, effective: Settings): SettingsForm => {
  const form: Record<string, FieldState> = {};
  for (const def of FIELDS) {
    const own = getAt(layer, def.path);
    const start = own !== undefined ? own : isRecordField(def) ? {} : getAt(effective, def.path);
    form[def.path] = { set: own !== undefined, value: toEdit(def, start) };
  }
  return form as SettingsForm;
};

/** The layer to save, or the fields that are not valid. */
export const layerFromForm = (
  form: SettingsForm,
): { readonly layer: SettingsLayer; readonly errors: FieldErrors } => {
  const layer: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const def of FIELDS) {
    const f = form[def.path];
    if (!f.set) continue;
    const parsed = fromEdit(def, f.value);
    if (parsed.ok) setAt(layer, def.path, parsed.value);
    else errors[def.path] = parsed.error;
  }
  return { layer: layer as SettingsLayer, errors: errors as FieldErrors };
};

/** The form without React row keys, to tell whether it changed. */
export const formSignature = (form: SettingsForm): string =>
  JSON.stringify(
    FIELDS.map((d) => {
      const f = form[d.path];
      const v = f.value;
      const value = v.kind === "run" || v.kind === "env" ? v.rows.map((r) => ({ ...r, key: 0 })) : v;
      return [f.set, value];
    }),
  );

const stable = (u: unknown): unknown =>
  Array.isArray(u)
    ? u.map(stable)
    : isObj(u)
      ? Object.fromEntries(
          Object.keys(u)
            .filter((k) => u[k] !== undefined)
            .sort()
            .map((k) => [k, stable(u[k])]),
        )
      : u;

export const sameLayer = (a: unknown, b: unknown): boolean =>
  JSON.stringify(stable(a)) === JSON.stringify(stable(b));

// Effective values and where they came from (04: Tempo, .tempo, .conductor, conductor.json or default).

export interface EffectiveContext {
  /** The open workspace's effective settings, when it belongs to this project. */
  readonly settings: Settings | null;
  readonly sources: Readonly<Record<string, SettingsSource>> | null;
  /** The project's saved overrides. */
  readonly layer: SettingsLayer;
}

export interface EffectiveEntry {
  readonly key: string;
  readonly text: string;
  readonly source: SettingsSource;
}

export const sourceLabel = (s: SettingsSource): string => SETTINGS_SOURCE_LABELS[s];

const sourceOf = (ctx: EffectiveContext, path: string, fromLayer: boolean): SettingsSource => {
  if (ctx.settings && ctx.sources) return ctx.sources[path] ?? "default";
  return fromLayer ? "tempo" : "default";
};

export const formatValue = (def: FieldDef, value: unknown): string => {
  switch (def.kind) {
    case "bool":
      return value === true ? "On" : "Off";
    case "select":
      return def.options?.find((o) => o.value === value)?.label ?? String(value ?? "");
    case "hosts":
      return Array.isArray(value) && value.length > 0 ? value.join(", ") : "None";
    case "instance":
      return value === undefined ? "" : instanceLabel(value as Instance);
    case "number":
      return String(value ?? "");
    default:
      return typeof value === "string" && value !== "" ? value : "Empty";
  }
};

/** One leaf key's effective value and source. */
export const effectiveLeaf = (
  def: FieldDef,
  ctx: EffectiveContext,
): { readonly text: string; readonly source: SettingsSource } => {
  const own = getAt(ctx.layer, def.path);
  const value = ctx.settings
    ? getAt(ctx.settings, def.path)
    : own !== undefined
      ? own
      : getAt(DEFAULT_SETTINGS, def.path);
  return { text: formatValue(def, value), source: sourceOf(ctx, def.path, own !== undefined) };
};

/** Run scripts or variables in effect, one row per entry with its own source. */
export const effectiveEntries = (def: FieldDef, ctx: EffectiveContext): EffectiveEntry[] => {
  const record = getAt(ctx.settings ?? ctx.layer, def.path);
  const ownRecord = getAt(ctx.layer, def.path);
  if (!isObj(record)) return [];
  const prefix = def.kind === "run" ? "scripts.run" : "environment_variables";
  return Object.entries(record).map(([k, v]) => {
    const fromLayer = isObj(ownRecord) && k in ownRecord;
    const text =
      def.kind === "run" && isObj(v)
        ? `${String(v["command"] ?? "")}${typeof v["cwd"] === "string" && v["cwd"] ? ` (in ${v["cwd"]})` : ""}${v["default"] === true ? " · default" : ""}`
        : `${k}=${String(v)}`;
    return { key: k, text, source: sourceOf(ctx, `${prefix}.${k}`, fromLayer) };
  });
};

export const isSecretName = Schema.is(EnvName);
