import { Schema } from "effect";

/**
 * ACP v1 shapes that Tempo stores and shows. They are copied as is from the agent, so most
 * fields stay loose: Tempo validates the parts it reads and passes the rest through.
 */
export const Meta = Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)));

export const ToolKind = Schema.String;

export const ContentBlock = Schema.Record(Schema.String, Schema.Unknown).check(
  Schema.makeFilter((b) => typeof b["type"] === "string" || "content block needs a type"),
);
export type ContentBlock = { readonly type: string; readonly [k: string]: unknown };

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

export const Capabilities = Schema.Record(Schema.String, Schema.Unknown);
export type Capabilities = typeof Capabilities.Type;

/** Flattens grouped select options. */
export const flattenConfigOptions = (option: ConfigOption): ReadonlyArray<ConfigSelectOption> =>
  (option.options ?? []).flatMap((o) => ("group" in o ? o.options : [o]));

export const modelOption = (options: ReadonlyArray<ConfigOption>): ConfigOption | undefined =>
  options.find((o) => o.category === "model");
