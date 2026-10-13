import { Predicate, Schema } from "effect";
import {
  MAX_MESSAGE_BYTES,
  type AcpFields,
  type JsonData,
  type JsonDataArray,
  type JsonDataFields,
} from "@tempo/protocol";

/** Size limits that keep every message under 1 MiB (02, tempod protocol). */

/** Room for the variable part of one response, leaving space for the envelope and the other fields. */
export const MESSAGE_BUDGET = MAX_MESSAGE_BYTES - 64 * 1024;

/** Item content in `item.created` and `item.updated`. */
export const ITEM_CONTENT_MAX = 512 * 1024;

/** The file list in `git.changed`; the totals still count every file. */
export const CHANGED_FILES_MAX = 512 * 1024;

/** Inline images, audio and resource blobs above this (base64 chars) are saved to a file instead. */
export const INLINE_BLOB_MAX = 256 * 1024;

/** Text per `script.output` or `item.delta`: far below 1 MiB even when JSON escapes every char. */
export const MAX_TEXT_CHARS = 128 * 1024;

export const TRUNCATED = "[tempo: truncated]";

type Obj = JsonDataFields;

const isObj = (value: JsonData): value is JsonDataFields => Predicate.isObject(value);

const isArray = (value: JsonData): value is JsonDataArray => Array.isArray(value);

export const jsonBytes = <T>(v: T): number => Buffer.byteLength(JSON.stringify(v) ?? "");

/** Splits text into pieces of at most `max` chars, never inside a surrogate pair. */
export const splitText = (text: string, max = MAX_TEXT_CHARS): string[] => {
  const out: string[] = [];
  let i = 0;

  while (i < text.length) {
    let end = Math.min(i + max, text.length);

    if (end < text.length) {
      const c = text.charCodeAt(end - 1);

      if (c >= 0xd800 && c <= 0xdbff) end -= 1;
    }

    out.push(text.slice(i, end));
    i = end;
  }

  return out;
};

/** The last lines whose JSON-escaped text fits in `maxBytes` (escapes can blow up ANSI-coloured output). */
export const tailLines = (lines: ReadonlyArray<string>, maxBytes: number): string => {
  let bytes = 2;
  let start = lines.length;

  while (start > 0) {
    const b = jsonBytes(lines[start - 1]);

    if (bytes + b > maxBytes) break;
    bytes += b;
    start -= 1;
  }

  return lines.slice(start).join("\n");
};

/** The longest prefix of `items` whose JSON array fits in `maxBytes`. */
export const capList = <A>(items: ReadonlyArray<A>, maxBytes: number): A[] => {
  const out: A[] = [];
  let bytes = 2;

  for (const item of items) {
    const b = jsonBytes(item) + 1;

    if (bytes + b > maxBytes) break;
    bytes += b;
    out.push(item);
  }

  return out;
};

const cut = (s: string, limit: number): string => {
  if (s.length <= limit) return s;
  let end = limit;
  const c = s.charCodeAt(end - 1);

  if (c >= 0xd800 && c <= 0xdbff) end -= 1;

  return `${s.slice(0, end)}\n${TRUNCATED}`;
};

const truncateStrings = (v: JsonData, limit: number, depth = 0): JsonData => {
  if (Predicate.isString(v)) return cut(v, limit);

  if (depth > 32 || (!isObj(v) && !isArray(v))) return v;

  if (isArray(v)) return v.map((x) => truncateStrings(x, limit, depth + 1));
  const out: Obj = {};

  for (const [k, x] of Object.entries(v)) out[k] = truncateStrings(x, limit, depth + 1);

  return out;
};

const STRING_LIMITS = [64 * 1024, 16 * 1024, 4 * 1024, 1024, 256];

/**
 * Item content whose JSON fits in `maxBytes`. Long strings (text, diff oldText/newText, raw input and
 * output) are cut with a visible marker; as a last resort lists are shortened and large objects dropped.
 */
const truncateFields = (value: JsonDataFields, limit: number): JsonDataFields => {
  const fields: JsonDataFields = {};

  for (const [key, child] of Object.entries(value)) fields[key] = truncateStrings(child, limit, 1);

  return fields;
};

export const boundContent = (content: AcpFields, maxBytes = ITEM_CONTENT_MAX): AcpFields => {
  if (jsonBytes(content) <= maxBytes) return content;

  // This branch already serializes content for its size; normalize optional fields to the JSON wire value.
  const fields = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
    JSON.parse(JSON.stringify(content)),
  );

  for (const limit of STRING_LIMITS) {
    const next = truncateFields(fields, limit);

    if (jsonBytes(next) <= maxBytes) return next;
  }

  const small = truncateFields(fields, 256);
  const share = Math.floor(maxBytes / (Object.keys(small).length + 1));
  const out: Obj = {};

  for (const [k, v] of Object.entries(small)) {
    if (Array.isArray(v)) out[k] = capList(v, share);
    else if (isObj(v)) out[k] = jsonBytes(v) <= share ? v : TRUNCATED;
    else out[k] = v;
  }

  return out;
};

export type SaveBlob = (data: string, mimeType: string | null) => { uri: string; name: string } | null;

const blobLink = (data: string, mimeType: JsonData, save: SaveBlob): JsonDataFields => {
  const mime = Schema.is(Schema.String)(mimeType) ? mimeType : null;
  const saved = save(data, mime);

  if (!saved) return { type: "text", text: `${TRUNCATED} (${mime ?? "binary"} content too large to show)` };

  const link = {
    type: "resource_link",
    uri: saved.uri,
    name: saved.name,
    size: Math.floor((data.length * 3) / 4),
  };

  return mime ? { ...link, mimeType: mime } : link;
};

/** Replaces large inline images, audio and resource blobs with `resource_link`s to saved files. */
export const offloadBlobs = (v: JsonData, save: SaveBlob, max = INLINE_BLOB_MAX, depth = 0): JsonData => {
  if (depth > 32 || (!isObj(v) && !isArray(v))) return v;

  if (isArray(v)) return v.map((x) => offloadBlobs(x, save, max, depth + 1));
  const o = v;
  const type = o["type"];
  const data = o["data"];

  if ((type === "image" || type === "audio") && Predicate.isString(data) && data.length > max) {
    return blobLink(data, o["mimeType"], save);
  }

  const resource = o["resource"];

  if (
    type === "resource" &&
    isObj(resource) &&
    Predicate.isString(resource["blob"]) &&
    resource["blob"].length > max
  ) {
    return blobLink(resource["blob"], resource["mimeType"], save);
  }

  const out: Obj = {};

  for (const [k, x] of Object.entries(o)) out[k] = offloadBlobs(x, save, max, depth + 1);

  return out;
};
