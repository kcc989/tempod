import {
  API,
  Capabilities,
  EnvironmentProposal,
  Injector,
  SecretBinding,
  ITEM_CONTENT,
  PermissionOption,
  Session,
  Settings,
  SettingsLayer,
  Source,
  TempoError,
  TurnPrompt,
  TurnUsage,
  WorkspaceSummary,
  type ItemKind,
} from "@tempo/protocol";
import { Schema, type Exit } from "effect";
import { log } from "../log.ts";

/** JSON columns are validated with Effect Schema on every read and write (02, Conventions). */
export interface JsonColumn<T> {
  /** A missing value gives `fallback`; an unreadable or invalid one gives `fallback` and a `warn` log. */
  read(text: string | null | undefined, fallback: T): T;
  read<F>(text: string | null | undefined, fallback: F): T | F;
  /** Throws INTERNAL for a value that does not match the column's schema. */
  write(value: T): string;
  /** Like `write`, but logs at `warn` and returns null instead of throwing. */
  tryWrite(value: T): string | null;
}

const UNREADABLE = Symbol("unreadable");

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return UNREADABLE;
  }
};

const isObject = (u: unknown): u is Record<string, unknown> =>
  typeof u === "object" && u !== null && !Array.isArray(u);

export const jsonColumn = <S extends Schema.ConstraintDecoder<unknown>>(
  column: string,
  schema: S,
): JsonColumn<S["Type"]> => {
  const decode = Schema.decodeUnknownExit(schema);
  const valid = (value: unknown): boolean => decode(value)._tag === "Success";
  const read = <F>(text: string | null | undefined, fallback: F): S["Type"] | F => {
    if (text === null || text === undefined || text === "") return fallback;
    const r = decode(parse(text));
    if (r._tag === "Success") return r.value;
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
} as const;

export const EMPTY_PROMPT: TurnPrompt = { text: "", mentions: [], attachmentIds: [], reviewCommentIds: [] };

export type ItemContent<K extends ItemKind = ItemKind> = (typeof ITEM_CONTENT)[K]["Type"];

const ITEM_DEFAULTS: { readonly [K in ItemKind]: ItemContent<K> } = {
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
};

const ITEM_DECODERS = Object.fromEntries(
  Object.entries(ITEM_CONTENT).map(([kind, schema]) => [
    kind,
    Schema.decodeUnknownExit(schema as Schema.ConstraintDecoder<unknown>),
  ]),
) as Record<string, (input: unknown) => Exit.Exit<unknown, unknown>>;

/**
 * Content that matches the kind's schema (02, Item model): the value itself, else the kind's empty
 * content with each of the value's fields that keeps it valid. Anything but the first logs at warn.
 */
export const validItemContent = (kind: string, value: unknown): ItemContent => {
  const decode = ITEM_DECODERS[kind];
  if (!decode) throw new TempoError("INTERNAL", undefined, `unknown item kind ${kind}`);
  const r = decode(value);
  if (r._tag === "Success") return r.value as ItemContent;
  log("warn", "invalid item content", { kind });
  let repaired: unknown = ITEM_DEFAULTS[kind as ItemKind];
  if (isObject(value)) {
    for (const [key, field] of Object.entries(value)) {
      const next = { ...(repaired as Record<string, unknown>), [key]: field };
      const ok = decode(next);
      if (ok._tag === "Success") repaired = ok.value;
    }
  }
  return repaired as ItemContent;
};

export const readItemContent = (kind: string, text: string): ItemContent =>
  validItemContent(kind, parse(text));
