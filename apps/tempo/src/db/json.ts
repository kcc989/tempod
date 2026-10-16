import {
  AgentProfile,
  AcpFields,
  API,
  Capabilities,
  EnvironmentProposal,
  Injector,
  ModelPick,
  SecretBinding,
  ITEM_CONTENT,
  PermissionOption,
  ProfileIssue,
  Session,
  Settings,
  SettingsLayer,
  Source,
  TempoError,
  TurnPrompt,
  TurnUsage,
  WorkspaceSummary,
  type ItemKind,
  type JsonData,
} from "@tempo/protocol";
import { Schema, SchemaGetter, Exit } from "effect";
import { log } from "../log.ts";

/** JSON columns are validated with Effect Schema on every read and write (02, Conventions). */
export interface JsonColumn<T> {
  /** A missing value gives `fallback`; an unreadable or invalid one gives `fallback` and a `warn` log. */
  read(text: string | null | undefined, fallback: T): T;
  read<F>(text: string | null | undefined, fallback: F): T | F;
  /** Throws INTERNAL for a value that does not match the column's schema. */
  write(value: T | JsonData): string;
  /** Like `write`, but logs at `warn` and returns null instead of throwing. */
  tryWrite(value: T | JsonData): string | null;
}

export const jsonColumn = <S extends Schema.ConstraintDecoder<unknown>>(
  column: string,
  schema: S,
): JsonColumn<S["Type"]> => {
  const decode = Schema.decodeUnknownExit(schema);
  const decodeText = Schema.decodeUnknownExit(Schema.fromJsonString(schema));
  const valid = (value: S["Type"] | JsonData): boolean => Exit.isSuccess(decode(value));

  const read = <F>(text: string | null | undefined, fallback: F): S["Type"] | F => {
    if (text === null || text === undefined || text === "") return fallback;
    const r = decodeText(text);

    if (Exit.isSuccess(r)) return r.value;
    log("warn", "invalid JSON column value", { column });

    return fallback;
  };

  return {
    read,
    write: (value) => {
      if (!valid(value)) throw new TempoError("INTERNAL", undefined, `invalid ${column}`);

      return JSON.stringify(value);
    },
    tryWrite: (value) => {
      if (valid(value)) return JSON.stringify(value);
      log("warn", "invalid JSON column value not written", { column });

      return null;
    },
  };
};

/** codex: {"lastRefresh": <ms>} (02, CredentialDO). */
export const SecretMeta = Schema.Struct({ lastRefresh: Schema.optional(Schema.Number) });

export type SecretMeta = typeof SecretMeta.Type;

export const json = {
  settings: jsonColumn("workspace.settings_json", Settings),
  projectSettings: jsonColumn("projects.settings_json", SettingsLayer),
  source: jsonColumn("workspace.source_json", Source),
  autoRestarts: jsonColumn("workspace.auto_restarts_json", Schema.Array(Schema.Number)),
  modes: jsonColumn("sessions.modes_json", Session.fields.modes),
  configOptions: jsonColumn("sessions.config_options_json", Session.fields.configOptions),
  config: jsonColumn("sessions.config_json", Session.fields.config),
  commands: jsonColumn("sessions.commands_json", Session.fields.commands),
  usage: jsonColumn("sessions.usage_json", Session.fields.usage),
  capabilities: jsonColumn("sessions.capabilities_json", Capabilities),
  prompt: jsonColumn("turns.prompt_json", TurnPrompt),
  turnUsage: jsonColumn("turns.usage_json", TurnUsage),
  permissionOptions: jsonColumn("permissions.options_json", Schema.Array(PermissionOption)),
  summary: jsonColumn("summaries.summary_json", WorkspaceSummary),
  secretMeta: jsonColumn("secrets.meta_json", SecretMeta),
  fileResponse: jsonColumn("file_cache.response_json", API.readFile.output),
  egressAllowlist: jsonColumn("environments.egress_allowlist_json", Schema.Array(Schema.String)),
  environmentSecrets: jsonColumn("environments.secrets_json", Schema.Array(SecretBinding)),
  environmentInjectors: jsonColumn("environments.injectors_json", Schema.Array(Injector)),
  environmentProposal: jsonColumn("environment_proposals.proposal_json", EnvironmentProposal),
  profile: jsonColumn("sessions.profile_json", AgentProfile),
  modelPicks: jsonColumn("model_lists.models_json", Schema.Array(ModelPick)),
  profileIssues: jsonColumn("sessions.profile_issues_json", Schema.Array(ProfileIssue)),
} as const;

export const EMPTY_PROMPT: TurnPrompt = { text: "", mentions: [], attachmentIds: [], reviewCommentIds: [] };

export type ItemContent<K extends ItemKind = ItemKind> = (typeof ITEM_CONTENT)[K]["Type"];

const ITEM_DEFAULTS = {
  run: { runId: "" },
  agent_proposal: { proposalId: "" },
  user_message: { text: "", mentions: [], attachments: [], reviewCommentIds: [] },
  agent_message: { text: "" },
  agent_thought: { text: "" },
  tool_call: { toolCallId: "", title: "", locations: [], content: [] },
  plan: { entries: [] },
  permission: { requestId: "", title: "", options: [] },
  notice: { level: "warning", text: "" },
  handoff: { text: "" },
  revert_marker: { checkpointId: "", toTurnSeq: 0 },
  error: { code: "INTERNAL" },
  intent: {
    intentId: "",
    status: "awaiting",
    goal: "",
    approach: "",
    notDoing: "",
    decidedBy: null,
    reasons: [],
    enforced: false,
  },
  proof: {
    proofId: "",
    summary: "",
    screens: [],
    checks: [],
    resolved: [],
    missingRoutes: [],
    missingChecklist: [],
    status: "checking",
  },
  cloudflare_hold: { holdId: "", method: "", path: "", resource: null, reasons: [], status: "pending" },
  cloudflare_access: { requestId: "", permissions: [], reason: "", status: "pending" },
  artifact: {
    artifactId: "",
    version: 1,
    title: "",
    name: "",
    path: "",
    mime: "application/octet-stream",
    artifactKind: "text",
    size: 0,
  },
} satisfies { readonly [K in ItemKind]: ItemContent<K> };

const itemSchemas: ReadonlyMap<string, Schema.Codec<ItemContent>> = new Map(Object.entries(ITEM_CONTENT));

const itemDefaults: ReadonlyMap<string, ItemContent> = new Map(Object.entries(ITEM_DEFAULTS));

/** Decode content at its persistence boundary, repairing invalid fields against the kind's defaults. */
export const itemContentDecoder = (kind: string) => {
  const schema = itemSchemas.get(kind);
  const defaults = itemDefaults.get(kind);

  if (!schema || !defaults) throw new TempoError("INTERNAL", undefined, `unknown item kind ${kind}`);
  const decode = Schema.decodeUnknownExit(schema);

  return Schema.decodeUnknownSync(
    Schema.Unknown.pipe(
      Schema.decodeTo(schema, {
        decode: SchemaGetter.transform((value) => {
          const result = decode(value);

          if (Exit.isSuccess(result)) return result.value;
          log("warn", "invalid item content", { kind });
          let repaired = defaults;

          if (Schema.is(AcpFields)(value)) {
            for (const [key, field] of Object.entries(value)) {
              const next = decode({ ...repaired, [key]: field });

              if (Exit.isSuccess(next)) repaired = next.value;
            }
          }

          return repaired;
        }),
        encode: SchemaGetter.passthrough(),
      }),
    ),
  );
};

export const readItemContent = (kind: string, text: string): ItemContent => {
  let value;

  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }

  return itemContentDecoder(kind)(value);
};
