import { Schema, SchemaGetter } from "effect";

/**
 * ACP v1 shapes that Tempo stores and shows. They are copied as is from the agent, so most
 * fields stay loose: Tempo validates the parts it reads and passes the rest through.
 */
/** Extensible ACP field containers; consumers validate the individual fields they read. */
export const AcpFields = Schema.Record(Schema.String, Schema.Unknown);

export type AcpFields = typeof AcpFields.Type;

export const Meta = Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)));

export const ToolKind = Schema.String;

export const AcpUpdate = Schema.StructWithRest(Schema.Struct({ sessionUpdate: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);

export type AcpUpdate = typeof AcpUpdate.Type;

export const AcpSessionNotification = Schema.Struct({ sessionId: Schema.String, update: AcpUpdate });

export type AcpSessionNotification = typeof AcpSessionNotification.Type;

export const ContentBlock = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);

export type ContentBlock = typeof ContentBlock.Type;

export const ToolCallContent = ContentBlock;

export type ToolCallContent = ContentBlock;

export const SessionMode = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

export type SessionMode = typeof SessionMode.Type;

export const ConfigSelectOption = Schema.Struct({
  value: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

export type ConfigSelectOption = typeof ConfigSelectOption.Type;

export const ConfigSelectGroup = Schema.Struct({
  group: Schema.String,
  name: Schema.String,
  options: Schema.Array(ConfigSelectOption),
});

export const ConfigOption = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  category: Schema.optional(Schema.NullOr(Schema.String)),
  currentValue: Schema.Union([Schema.String, Schema.Boolean]),
  options: Schema.optional(Schema.Array(Schema.Union([ConfigSelectOption, ConfigSelectGroup]))),
});

export type ConfigOption = typeof ConfigOption.Type;

export const AvailableCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  input: Schema.optional(Schema.Unknown),
});

export type AvailableCommand = typeof AvailableCommand.Type;

export const PermissionOption = Schema.Struct({
  optionId: Schema.String,
  name: Schema.String,
  kind: Schema.String,
});

export type PermissionOption = typeof PermissionOption.Type;

export const PlanEntry = Schema.Struct({
  content: Schema.String,
  priority: Schema.String,
  status: Schema.String,
});

export type PlanEntry = typeof PlanEntry.Type;

export const ToolLocation = Schema.Struct({
  path: Schema.String,
  line: Schema.optional(Schema.NullOr(Schema.Number)),
});

export type ToolLocation = typeof ToolLocation.Type;

export const Usage = Schema.Record(Schema.String, Schema.Unknown);

export type Usage = typeof Usage.Type;

/** ACP v1 `PromptResponse.usage`: the token counts the agent reports for one turn. */
export const TurnUsage = Schema.Struct({
  totalTokens: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  thoughtTokens: Schema.optional(Schema.Number),
  cachedReadTokens: Schema.optional(Schema.Number),
  cachedWriteTokens: Schema.optional(Schema.Number),
});

export type TurnUsage = typeof TurnUsage.Type;

const tokenCount = Schema.decodeUnknownSync(
  Schema.Unknown.pipe(
    Schema.decodeTo(Schema.UndefinedOr(Schema.Number), {
      decode: SchemaGetter.transform((value) =>
        Schema.is(Schema.Number)(value) && Number.isFinite(value) && value >= 0
          ? Math.round(value)
          : undefined,
      ),
      encode: SchemaGetter.passthrough(),
    }),
  ),
);

type MutableTurnUsage = { -readonly [K in keyof TurnUsage]: TurnUsage[K] };

/** Decode ACP counts, discarding malformed optional fields and requiring the three core counts. */
export const toTurnUsage = Schema.decodeUnknownSync(
  Schema.Unknown.pipe(
    Schema.decodeTo(Schema.NullOr(TurnUsage), {
      decode: SchemaGetter.transform((value) => {
        if (!Schema.is(AcpFields)(value)) return null;
        const totalTokens = tokenCount(value["totalTokens"]);
        const inputTokens = tokenCount(value["inputTokens"]);
        const outputTokens = tokenCount(value["outputTokens"]);

        if (totalTokens === undefined || inputTokens === undefined || outputTokens === undefined) return null;
        const usage: MutableTurnUsage = { totalTokens, inputTokens, outputTokens };

        for (const key of ["thoughtTokens", "cachedReadTokens", "cachedWriteTokens"] as const) {
          const count = tokenCount(value[key]);

          if (count !== undefined) usage[key] = count;
        }

        return usage;
      }),
      encode: SchemaGetter.passthrough(),
    }),
  ),
);

export const Capabilities = Schema.Record(Schema.String, Schema.Unknown);

export type Capabilities = typeof Capabilities.Type;

/** Flattens grouped select options. */
export const flattenConfigOptions = (option: ConfigOption): ReadonlyArray<ConfigSelectOption> =>
  (option.options ?? []).flatMap((o) => ("group" in o ? o.options : [o]));

export const modelOption = (options: ReadonlyArray<ConfigOption>): ConfigOption | undefined =>
  options.find((o) => o.category === "model");
