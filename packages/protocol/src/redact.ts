import { Predicate, Schema, SchemaGetter } from "effect";

import type { JsonData, JsonDataArray, JsonDataFields } from "./json-data.ts";

export type Redactable = JsonData;

export type RedactableArray = JsonDataArray;

export type RedactableFields = JsonDataFields;

/** Redaction rule shared by every logger (05, Secrets). */
export const SECRET_FIELD = /token|key|secret|password|authorization|auth_json|cookie/i;

export const REDACTED = "[redacted]";

const isFields = (value: Redactable): value is RedactableFields => Predicate.isObject(value);

const isArray = (value: Redactable): value is RedactableArray => Array.isArray(value);

export const redact = (value: Redactable, depth = 0): Redactable => {
  if (!isFields(value) && !isArray(value)) return value;

  if (depth > 8) return "[truncated]";

  if (isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: { [key: string]: Redactable } = {};

  for (const [key, entry] of Object.entries(value)) {
    out[key] = SECRET_FIELD.test(key) ? REDACTED : redact(entry, depth + 1);
  }

  return out;
};

/** Field containers remain field containers at the logging boundary. */
export const redactFields = (fields: RedactableFields): RedactableFields => {
  const out: { [key: string]: Redactable } = {};

  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_FIELD.test(key) ? REDACTED : redact(value, 1);
  }

  return out;
};

const PayloadData = Schema.Union([Schema.Json, Schema.Undefined]);

/** External logger and ACP payloads can contain values beyond JSON; normalize them while redacting. */
const payloadAt = (depth: number): ReturnType<typeof Schema.decodeUnknownSync<typeof PayloadData>> =>
  Schema.decodeUnknownSync(
    Schema.Unknown.pipe(
      Schema.decodeTo(PayloadData, {
        decode: SchemaGetter.transform((value) => {
          if (
            value === null ||
            value === undefined ||
            Schema.is(Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))(value)
          )
            return value;

          if (depth > 8) return "[truncated]";

          if (Array.isArray(value)) return value.map((entry) => payloadAt(depth + 1)(entry) ?? null);

          if (Predicate.isObject(value)) {
            const fields: Record<string, Schema.Json> = {};

            for (const [key, entry] of Object.entries(value)) {
              const redacted = SECRET_FIELD.test(key) ? REDACTED : payloadAt(depth + 1)(entry);

              if (redacted !== undefined) fields[key] = redacted;
            }

            return fields;
          }

          return String(value);
        }),
        encode: SchemaGetter.passthrough(),
      }),
    ),
  );

export const redactPayload = payloadAt(0);
