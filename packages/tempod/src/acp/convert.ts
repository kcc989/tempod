import {
  NoticeLevel,
  PermissionOption,
  ToolLocation,
  AcpFields,
  AvailableCommand,
  ConfigOption,
  ConfigSelectOption,
  SessionMode,
} from "@tempo/protocol";
import { Schema, SchemaGetter } from "effect";

export const isObj = Schema.is(AcpFields);

const str = Schema.decodeUnknownSync(
  Schema.Unknown.pipe(
    Schema.decodeTo(Schema.UndefinedOr(Schema.String), {
      decode: SchemaGetter.transform((value) => (Schema.is(Schema.String)(value) ? value : undefined)),
      encode: SchemaGetter.passthrough(),
    }),
  ),
);

export const toModes = Schema.decodeUnknownSync(
  Schema.Unknown.pipe(
    Schema.decodeTo(Schema.mutable(Schema.Array(SessionMode)), {
      decode: SchemaGetter.transform((value) => {
        if (!Array.isArray(value)) return [];
        const out: SessionMode[] = [];

        for (const entry of value) {
          if (!isObj(entry) || !Schema.is(Schema.String)(entry["id"])) continue;
          const mode = { id: entry["id"], name: str(entry["name"]) ?? entry["id"] };
          const description = str(entry["description"]);
          out.push(description === undefined ? mode : { ...mode, description });
        }

        return out;
      }),
      encode: SchemaGetter.passthrough(),
    }),
  ),
);

const toSelectOptions = (entries: ReadonlyArray<unknown>): NonNullable<ConfigOption["options"]> => {
  const out: Array<NonNullable<ConfigOption["options"]>[number]> = [];

  for (const entry of entries) {
    if (!isObj(entry)) continue;

    if (Array.isArray(entry["options"]) && Schema.is(Schema.String)(entry["group"])) {
      const options = toSelectOptions(entry["options"]).filter(
        (option): option is ConfigSelectOption => !("group" in option),
      );

      out.push({ group: entry["group"], name: str(entry["name"]) ?? entry["group"], options });
    } else if (Schema.is(Schema.String)(entry["value"])) {
      const option = { value: entry["value"], name: str(entry["name"]) ?? entry["value"] };
      const description = str(entry["description"]);
      out.push(description === undefined ? option : { ...option, description });
    }
  }

  return out;
};

export const toConfigOptions = Schema.decodeUnknownSync(
  Schema.Unknown.pipe(
    Schema.decodeTo(Schema.mutable(Schema.Array(ConfigOption)), {
      decode: SchemaGetter.transform((value) => {
        if (!Array.isArray(value)) return [];
        const out: ConfigOption[] = [];

        for (const entry of value) {
          if (!isObj(entry) || !Schema.is(Schema.String)(entry["id"])) continue;
          const currentValue = entry["currentValue"];

          if (!Schema.is(Schema.Union([Schema.String, Schema.Boolean]))(currentValue)) continue;

          let option: ConfigOption = {
            id: entry["id"],
            name: str(entry["name"]) ?? entry["id"],
            type: str(entry["type"]) ?? (Schema.is(Schema.Boolean)(currentValue) ? "boolean" : "select"),
            currentValue,
          };

          const description = str(entry["description"]);
          const category = str(entry["category"]);

          if (description !== undefined) option = { ...option, description };

          if (category !== undefined) option = { ...option, category };

          if (Array.isArray(entry["options"]))
            option = { ...option, options: toSelectOptions(entry["options"]) };
          out.push(option);
        }

        return out;
      }),
      encode: SchemaGetter.passthrough(),
    }),
  ),
);

export const toCommands = Schema.decodeUnknownSync(
  Schema.Unknown.pipe(
    Schema.decodeTo(Schema.mutable(Schema.Array(AvailableCommand)), {
      decode: SchemaGetter.transform((value) => {
        if (!Array.isArray(value)) return [];
        const out: AvailableCommand[] = [];

        for (const entry of value) {
          if (!isObj(entry) || !Schema.is(Schema.String)(entry["name"])) continue;
          let command: AvailableCommand = { name: entry["name"] };
          const description = str(entry["description"]);

          if (description !== undefined) command = { ...command, description };

          if (entry["input"] !== undefined && entry["input"] !== null)
            command = { ...command, input: entry["input"] };
          out.push(command);
        }

        return out;
      }),
      encode: SchemaGetter.passthrough(),
    }),
  ),
);

/** Drops ACP `_meta` and the sessionUpdate tag from an update object. */
export const stripMeta = (input: AcpFields, ...drop: string[]): AcpFields => {
  const out: { [key: string]: AcpFields[string] } = {};

  for (const [key, value] of Object.entries(input)) {
    if (key !== "_meta" && !drop.includes(key)) out[key] = value;
  }

  return out;
};

/** Normalize optional ACP locations without carrying malformed entries into item content. */
export const toLocations = Schema.decodeUnknownSync(
  Schema.Unknown.pipe(
    Schema.decodeTo(Schema.mutable(Schema.Array(ToolLocation)), {
      decode: SchemaGetter.transform((value) => {
        if (!Array.isArray(value)) return [];

        return value.flatMap((entry) => {
          if (!isObj(entry) || !Schema.is(Schema.String)(entry["path"])) return [];
          const location = { path: entry["path"] };

          return [Schema.is(Schema.Number)(entry["line"]) ? { ...location, line: entry["line"] } : location];
        });
      }),
      encode: SchemaGetter.passthrough(),
    }),
  ),
);

export const toPermissionOptions = Schema.decodeUnknownSync(
  Schema.Unknown.pipe(
    Schema.decodeTo(Schema.mutable(Schema.Array(PermissionOption)), {
      decode: SchemaGetter.transform((value) => {
        if (!Array.isArray(value)) return [];

        return value.flatMap((entry) => {
          if (!isObj(entry) || !Schema.is(Schema.String)(entry["optionId"])) return [];

          return [
            {
              optionId: entry["optionId"],
              name: str(entry["name"]) ?? entry["optionId"],
              kind: String(entry["kind"] ?? ""),
            },
          ];
        });
      }),
      encode: SchemaGetter.passthrough(),
    }),
  ),
);

export const noticeLevel = Schema.decodeUnknownSync(
  Schema.Unknown.pipe(
    Schema.decodeTo(NoticeLevel, {
      decode: SchemaGetter.transform((value) => (Schema.is(NoticeLevel)(value) ? value : "info")),
      encode: SchemaGetter.passthrough(),
    }),
  ),
);

export const modeConfig = (options: readonly ConfigOption[]): ConfigOption | undefined =>
  options.find(
    (o) => o.category === "mode" && o.type === "select" && Schema.is(Schema.String)(o.currentValue),
  );

export const configModes = (option: ConfigOption): SessionMode[] =>
  (option.options ?? [])
    .flatMap((entry) => ("group" in entry ? entry.options : [entry]))
    .map((entry) => {
      let mode: SessionMode = { id: entry.value, name: entry.name };

      if (entry.description != null) mode = { ...mode, description: entry.description };

      return mode;
    });
