import { EGRESS_BLOCK_RULES, type Diagnostics, type EgressStatusFilter, type FnInput } from "@tempo/protocol";

/** Diagnostics (05, Observability): the egress filter input and small formatters. Pure, unit-tested. */

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
  (EGRESS_BLOCK_RULES as ReadonlyArray<number>).includes(r.rule);

/** 02 getDiagnostics: the server filters the egress rows; the defaults are left out. */
export const diagnosticsInput = (
  workspaceId: string,
  host: string,
  status: EgressStatusFilter,
): FnInput<"getDiagnostics"> => {
  const egressHost = host.trim();
  return {
    workspaceId,
    ...(egressHost !== "" ? { egressHost } : {}),
    ...(status !== "all" ? { egressStatus: status } : {}),
  };
};

export const hasEgressFilter = (host: string, status: EgressStatusFilter): boolean =>
  host.trim() !== "" || status !== "all";

export type Tone = "ok" | "warn" | "bad" | "muted";

export const egressTone = (r: EgressRow): Tone =>
  isBlocked(r) || r.status >= 500 ? "bad" : r.status >= 400 ? "warn" : r.status >= 200 ? "ok" : "muted";

export const logTone = (level: string): Tone =>
  level === "error" ? "bad" : level === "warn" ? "warn" : "muted";

export const opTone = (status: Diagnostics["ops"][number]["status"]): Tone =>
  status === "failed"
    ? "bad"
    : status === "running" || status === "pending"
      ? "warn"
      : status === "done"
        ? "ok"
        : "muted";

/** Step timings in run order: the order the op recorded them. */
export const timingRows = (timings: Readonly<Record<string, number>>): Array<{ step: string; ms: number }> =>
  Object.entries(timings).map(([step, ms]) => ({ step, ms }));

export const capabilityList = (caps: unknown): string[] => {
  const out: string[] = [];
  const walk = (v: unknown, prefix: string) => {
    if (v === true) out.push(prefix);
    else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      for (const [k, child] of Object.entries(v)) walk(child, prefix ? `${prefix}.${k}` : k);
    }
  };
  walk(caps, "");
  return out;
};
