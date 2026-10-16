import { Option, Schema } from "effect";
import { sha256Hex } from "../lib/crypto.ts";

/** 12, Production errors. */
export const ISSUES = {
  bodyBytes: 256 * 1024,
  titleChars: 200,
  textBytes: 4096,
  kept: 500,
  keptMs: 90 * 24 * 60 * 60_000,
  claimMs: 2 * 60_000,
} as const;

export const issuesSecretKey = (projectId: string): string => `issues.${projectId}.webhook_secret`;

export const issuesWebhookPath = (projectId: string): string => `/api/hooks/cloudflare-issues/${projectId}`;

/** The Notifications webhook envelope. `data` varies by alert type and is not documented for Issues. */
const Envelope = Schema.Struct({
  text: Schema.String,
  name: Schema.optional(Schema.String),
  alert_correlation_id: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Json),
  ts: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
});

export interface ParsedIssue {
  readonly issueKey: string;
  readonly worker: string | null;
  readonly versionId: string | null;
  readonly title: string;
  readonly text: string;
  /** When Cloudflare saw the error (the envelope's `ts`), or null. */
  readonly occurredAt: number | null;
}

const KEYS = {
  issue: ["issue_id"],
  worker: ["script_name", "worker_name", "worker", "service"],
  version: ["version_id", "script_version_id", "versionId"],
} as const;

/** The first nonempty string under one of `keys`, searched depth first. */
const findString = (
  value: Schema.Json | undefined,
  keys: ReadonlyArray<string>,
  depth = 0,
): string | null => {
  if (depth > 8) return null;

  const entries = Array.isArray(value)
    ? value.map((v) => ["", v] as const)
    : Schema.is(Schema.JsonObject)(value)
      ? Object.entries(value)
      : null;

  if (entries === null) return null;

  for (const [key, entry] of entries)
    if (keys.includes(key) && Schema.is(Schema.String)(entry) && entry !== "") return entry;

  for (const [, entry] of entries) {
    const found = findString(entry, keys, depth + 1);

    if (found !== null) return found;
  }

  return null;
};

const SECRETS = [/\bBearer\s+\S+/gi, /\b(token|key|secret|password)=[^\s&"']+/gi];

/** Removes bearer tokens and secret-looking query values, then cuts to the stored size. */
export const scrubText = (text: string): string => {
  let out = text;

  for (const pattern of SECRETS)
    out = out.replace(pattern, (match) => `${match.split(/[\s=]/)[0]} [redacted]`);

  const bytes = new TextEncoder().encode(out);

  return bytes.byteLength <= ISSUES.textBytes
    ? out
    : new TextDecoder().decode(bytes.slice(0, ISSUES.textBytes)).replace(/�$/, "");
};

/** Reads one webhook body. Null when it is not the Notifications envelope. */
export const parseIssue = async (body: Schema.Json): Promise<ParsedIssue | null> => {
  const envelope = Schema.decodeUnknownOption(Envelope)(body);

  if (Option.isNone(envelope)) return null;
  const { text, name, alert_correlation_id: correlation, data, ts } = envelope.value;

  return {
    issueKey: findString(data, KEYS.issue) ?? correlation ?? (await sha256Hex(text)),
    worker: findString(data, KEYS.worker),
    versionId: findString(data, KEYS.version),
    title: (name ?? "Production error").slice(0, ISSUES.titleChars),
    text: scrubText(text),
    occurredAt: timeOf(ts),
  };
};

/** Seconds, milliseconds or an ISO date, as milliseconds. */
const timeOf = (ts: number | string | undefined): number | null => {
  if (ts === undefined) return null;
  const ms = Schema.is(Schema.Number)(ts) ? (ts < 1e12 ? ts * 1000 : ts) : Date.parse(ts);

  return Number.isFinite(ms) ? ms : null;
};
