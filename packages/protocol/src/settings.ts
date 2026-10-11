import { Schema } from "effect";
import { AgentId, EgressPolicy, InstanceName, RunMode } from "./enums.ts";

export const RunScript = Schema.Struct({
  command: Schema.String,
  cwd: Schema.String,
  default: Schema.Boolean,
});
export type RunScript = typeof RunScript.Type;

const Int = Schema.Int;

export const CustomInstance = Schema.Struct({
  vcpu: Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
  memoryMib: Int.check(Schema.isBetween({ minimum: 4096, maximum: 12288 })),
  diskMb: Int.check(Schema.isBetween({ minimum: 1, maximum: 20000 })),
}).check(
  Schema.makeFilter((i) => i.memoryMib >= i.vcpu * 3072 || "at least 3 GiB of memory per vCPU is required"),
);
export type CustomInstance = typeof CustomInstance.Type;

export const Instance = Schema.Union([InstanceName, CustomInstance]);
export type Instance = typeof Instance.Type;

export const HostPattern = Schema.String.check(
  Schema.isPattern(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/),
);

export const EnvName = Schema.String.check(Schema.isPattern(/^[A-Z_][A-Z0-9_]*$/));

export const Settings = Schema.Struct({
  agent: Schema.Struct({ default: AgentId, model: Schema.String }),
  scripts: Schema.Struct({
    setup: Schema.String,
    archive: Schema.String,
    run_mode: RunMode,
    auto_run_after_setup: Schema.Boolean,
    run: Schema.Record(Schema.String, RunScript),
  }),
  environment: Schema.Struct({
    instance: Instance,
    sleep_after_idle_minutes: Int.check(Schema.isBetween({ minimum: 5, maximum: 240 })),
    egress_policy: EgressPolicy,
    egress_allowlist: Schema.Array(HostPattern),
  }),
  environment_variables: Schema.Record(Schema.String, Schema.String),
  git: Schema.Struct({
    branch_prefix: Schema.String,
    delete_branch_on_archive: Schema.Boolean,
    archive_on_merge: Schema.Boolean,
  }),
  prompts: Schema.Struct({ general: Schema.String }),
});
export type Settings = typeof Settings.Type;

export const DEFAULT_SETTINGS: Settings = {
  agent: { default: "claude", model: "" },
  scripts: { setup: "", archive: "", run_mode: "concurrent", auto_run_after_setup: false, run: {} },
  environment: {
    instance: "standard-3",
    sleep_after_idle_minutes: 15,
    egress_policy: "open",
    egress_allowlist: [],
  },
  environment_variables: {},
  git: { branch_prefix: "tempo/", delete_branch_on_archive: false, archive_on_merge: false },
  prompts: { general: "" },
};

const opt = Schema.optional;

/** One settings layer: every key optional. Used for files and for the project's UI overrides. */
export const SettingsLayer = Schema.Struct({
  agent: opt(Schema.Struct({ default: opt(AgentId), model: opt(Schema.String) })),
  scripts: opt(
    Schema.Struct({
      setup: opt(Schema.String),
      archive: opt(Schema.String),
      run_mode: opt(RunMode),
      auto_run_after_setup: opt(Schema.Boolean),
      run: opt(
        Schema.Record(
          Schema.String,
          Schema.Struct({ command: Schema.String, cwd: opt(Schema.String), default: opt(Schema.Boolean) }),
        ),
      ),
    }),
  ),
  environment: opt(
    Schema.Struct({
      instance: opt(Instance),
      sleep_after_idle_minutes: opt(Int.check(Schema.isBetween({ minimum: 5, maximum: 240 }))),
      egress_policy: opt(EgressPolicy),
      egress_allowlist: opt(Schema.Array(HostPattern)),
    }),
  ),
  environment_variables: opt(Schema.Record(Schema.String, Schema.String)),
  git: opt(
    Schema.Struct({
      branch_prefix: opt(Schema.String),
      delete_branch_on_archive: opt(Schema.Boolean),
      archive_on_merge: opt(Schema.Boolean),
    }),
  ),
  prompts: opt(Schema.Struct({ general: opt(Schema.String) })),
});
export type SettingsLayer = typeof SettingsLayer.Type;

export const SETTINGS_SOURCES = ["tempo", ".tempo", ".conductor", "conductor.json", "default"] as const;
export const SettingsSource = Schema.Literals(SETTINGS_SOURCES);
export type SettingsSource = typeof SettingsSource.Type;

/** UI labels for each source, as 04 names them. */
export const SETTINGS_SOURCE_LABELS: Record<SettingsSource, string> = {
  tempo: "Tempo",
  ".tempo": ".tempo",
  ".conductor": ".conductor",
  "conductor.json": "conductor.json",
  default: "default",
};

export const SettingsReadResult = Schema.Struct({
  effective: Settings,
  warnings: Schema.Array(Schema.String),
  errors: Schema.Array(Schema.String),
  /** Dotted key path → where its effective value came from. Additive field. */
  sources: opt(Schema.Record(Schema.String, SettingsSource)),
});
export type SettingsReadResult = typeof SettingsReadResult.Type;

export const instanceLabel = (instance: Instance): string =>
  typeof instance === "string"
    ? instance
    : `${instance.vcpu} vCPU, ${Math.round(instance.memoryMib / 1024)} GiB`;
