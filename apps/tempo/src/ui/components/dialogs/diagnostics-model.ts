import type { Diagnostics } from "@tempo/protocol";

/** Diagnostics (05, Observability): the egress filter and small formatters. Pure, unit-tested. */

export type EgressRow = Diagnostics["egress"][number];

/** TempoOutbound rules that refuse a request (01: rule 0 app host, 7 placeholder, 10 not allowed). */
export const BLOCK_RULES: ReadonlySet<number> = new Set([0, 7, 10]);

export const EGRESS_STATUS_FILTERS = [
  { value: "all", label: "All statuses" },
  { value: "blocked", label: "Blocked" },
  { value: "2xx", label: "2xx" },
  { value: "3xx", label: "3xx" },
  { value: "4xx", label: "4xx" },
  { value: "5xx", label: "5xx" },
] as const;

export type EgressStatusFilter = (typeof EGRESS_STATUS_FILTERS)[number]["value"];

export const isEgressStatusFilter = (s: string): s is EgressStatusFilter =>
  EGRESS_STATUS_FILTERS.some((f) => f.value === s);

export const isBlocked = (r: Pick<EgressRow, "rule">): boolean => BLOCK_RULES.has(r.rule);

export const matchesStatus = (r: EgressRow, filter: EgressStatusFilter): boolean => {
  switch (filter) {
    case "all":
      return true;
    case "blocked":
      return isBlocked(r);
    default:
      return Math.floor(r.status / 100) === Number(filter[0]);
  }
};

/** Rows whose host contains the text (any case) and whose status matches. Order is kept. */
export const filterEgress = (
  rows: ReadonlyArray<EgressRow>,
  host: string,
  status: EgressStatusFilter,
): EgressRow[] => {
  const q = host.trim().toLowerCase();
  return rows.filter((r) => (q === "" || r.host.toLowerCase().includes(q)) && matchesStatus(r, status));
};

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
