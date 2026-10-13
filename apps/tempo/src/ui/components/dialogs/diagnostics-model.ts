import {
  EGRESS_BLOCK_RULES,
  type Capabilities,
  type Diagnostics,
  type EgressStatusFilter,
  type FnInput,
} from "@tempo/protocol";
/** Diagnostics (05, Observability): the egress filter input and small formatters. Pure, unit-tested. */
import { Match, Option, Predicate, Schema } from "effect";

export type EgressRow = Diagnostics["egress"][number];

export const EGRESS_HOST_DEBOUNCE_MS = 250;

export const EGRESS_STATUS_FILTERS: ReadonlyArray<{ value: EgressStatusFilter; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "blocked", label: "Blocked" },
  { value: "2xx", label: "2xx" },
  { value: "3xx", label: "3xx" },
  { value: "4xx", label: "4xx" },
  { value: "5xx", label: "5xx" },
];

export const isEgressStatusFilter = (s: string): s is EgressStatusFilter =>
  EGRESS_STATUS_FILTERS.some((f) => f.value === s);

export const isBlocked = (r: Pick<EgressRow, "rule">): boolean =>
  EGRESS_BLOCK_RULES.some((rule) => rule === r.rule);

/** 02 getDiagnostics: the server filters the egress rows; the defaults are left out. */
export const diagnosticsInput = (
  workspaceId: string,
  host: string,
  status: EgressStatusFilter,
): FnInput<"getDiagnostics"> => {
  const egressHost = host.trim();

  let input: FnInput<"getDiagnostics"> = { workspaceId };

  if (egressHost !== "") input = { ...input, egressHost };

  if (status !== "all") input = { ...input, egressStatus: status };

  return input;
};

export const hasEgressFilter = (host: string, status: EgressStatusFilter): boolean =>
  host.trim() !== "" || status !== "all";

export type Tone = "ok" | "warn" | "bad" | "muted";

export const egressTone = (r: EgressRow): Tone =>
  Match.value(r).pipe(
    Match.when(
      (row) => isBlocked(row) || row.status >= 500,
      () => "bad" as const,
    ),
    Match.when(
      (row) => row.status >= 400,
      () => "warn" as const,
    ),
    Match.when(
      (row) => row.status >= 200,
      () => "ok" as const,
    ),
    Match.orElse(() => "muted" as const),
  );

export const logTone = (level: string): Tone =>
  Match.value(level).pipe(
    Match.when("error", () => "bad" as const),
    Match.when("warn", () => "warn" as const),
    Match.orElse(() => "muted" as const),
  );

export const opTone = (status: Diagnostics["ops"][number]["status"]): Tone =>
  Match.value(status).pipe(
    Match.when("failed", () => "bad" as const),
    Match.whenOr("running", "pending", () => "warn" as const),
    Match.when("done", () => "ok" as const),
    Match.orElse(() => "muted" as const),
  );

/** Step timings in run order: the order the op recorded them. */
export const timingRows = (timings: Readonly<Record<string, number>>): Array<{ step: string; ms: number }> =>
  Object.entries(timings).map(([step, ms]) => ({ step, ms }));

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject => Predicate.isObject(value);

export const capabilityList = (caps: Capabilities | null): string[] => {
  const out: string[] = [];

  const walk = (v: Schema.Json, prefix: string) => {
    if (v === true) out.push(prefix);
    else if (isJsonObject(v)) {
      for (const [k, child] of Object.entries(v)) walk(child, prefix ? `${prefix}.${k}` : k);
    }
  };

  const parsed = Schema.decodeUnknownOption(Schema.Json)(caps);

  if (Option.isSome(parsed)) walk(parsed.value, "");

  return out;
};
