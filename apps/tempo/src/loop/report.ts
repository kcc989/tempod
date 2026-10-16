import { Schema } from "effect";

/** 13, Targets and L-ADR-7: loop step times from the event log alone. */

export const LOOP_STEPS = [
  "intent_shown",
  "intent_corrections",
  "preview_proof",
  "proof_to_merge",
  "ci",
  "merge_to_live",
  "rollback",
  "error_seen",
  "error_fixed",
] as const;

export type LoopStep = (typeof LOOP_STEPS)[number];

const MIN = 60_000;

/** Target median and p90: milliseconds, or a count for `intent_corrections`. */
export const LOOP_TARGETS = new Map<LoopStep, { readonly median: number; readonly p90: number }>([
  ["intent_shown", { median: MIN, p90: 3 * MIN }],
  ["intent_corrections", { median: 1, p90: 2 }],
  ["preview_proof", { median: 20 * MIN, p90: 45 * MIN }],
  ["proof_to_merge", { median: 15 * MIN, p90: 60 * MIN }],
  ["ci", { median: 6 * MIN, p90: 15 * MIN }],
  ["merge_to_live", { median: 20 * MIN, p90: 30 * MIN }],
  ["rollback", { median: 30_000, p90: 60_000 }],
  ["error_seen", { median: 3 * MIN, p90: 6 * MIN }],
  ["error_fixed", { median: 60 * MIN, p90: 240 * MIN }],
]);

/** Gaps longer than this with no event in the workspace are not counted (13, Targets). */
export const IDLE_GAP_MS = 30 * MIN;

export interface LoopEvent {
  readonly workspaceId: string;
  readonly changeId: string | null;
  readonly type: string;
  readonly at: number;
  readonly payload: Schema.JsonObject;
}

export interface DeployEvent {
  readonly projectId: string;
  readonly deploymentId: string;
  readonly type: string;
  readonly at: number;
  readonly payload: Schema.JsonObject;
}

export interface LoopInput {
  readonly events: ReadonlyArray<LoopEvent>;
  readonly deploys: ReadonlyArray<DeployEvent>;
  /** The project of each workspace. */
  readonly projects: ReadonlyMap<string, string>;
}

export interface StepResult {
  readonly step: LoopStep;
  readonly n: number;
  readonly median: number | null;
  readonly p90: number | null;
  readonly targetMedian: number;
  readonly targetP90: number;
  /** Null when there is no sample. */
  readonly met: boolean | null;
}

/** Nearest-rank percentile of sorted values. */
export const percentile = (sorted: ReadonlyArray<number>, p: number): number | null => {
  if (sorted.length === 0) return null;

  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
};

/** Time from `from` to `to`, without gaps of more than 30 minutes between the workspace's events. */
export const activeTime = (marks: ReadonlyArray<number>, from: number, to: number): number => {
  const inside = [from, ...marks.filter((t) => t > from && t < to), to];
  let total = 0;

  for (let i = 1; i < inside.length; i++) {
    const gap = inside[i]! - inside[i - 1]!;

    if (gap <= IDLE_GAP_MS) total += gap;
  }

  return total;
};

const isNumber = Schema.is(Schema.Number);

const isString = Schema.is(Schema.String);

const num = (payload: Schema.JsonObject, key: string): number | null => {
  const v = payload[key];

  return isNumber(v) ? v : null;
};

const str = (payload: Schema.JsonObject, key: string): string | null => {
  const v = payload[key];

  return isString(v) ? v : null;
};

const groupBy = <T>(items: ReadonlyArray<T>, key: (t: T) => string | null): Map<string, T[]> => {
  const out = new Map<string, T[]>();

  for (const item of items) {
    const k = key(item);

    if (k === null) continue;
    out.set(k, [...(out.get(k) ?? []), item]);
  }

  return out;
};

const firstAfter = <T extends { at: number }>(list: ReadonlyArray<T>, at: number, test: (t: T) => boolean) =>
  list.find((e) => e.at >= at && test(e));

/** Samples for each step. Events must be sorted by time. */
export const loopSamples = (input: LoopInput): Map<LoopStep, number[]> => {
  const samples = new Map<LoopStep, number[]>(LOOP_STEPS.map((s) => [s, []]));
  const add = (step: LoopStep, value: number) => samples.get(step)!.push(value);
  const byWorkspace = groupBy(input.events, (e) => e.workspaceId);
  const marks = new Map([...byWorkspace].map(([id, list]) => [id, list.map((e) => e.at)]));
  const timed = (e: LoopEvent, to: number) => activeTime(marks.get(e.workspaceId) ?? [], e.at, to);

  for (const list of groupBy(input.events, (e) => e.changeId).values()) {
    const created = list.find((e) => e.type === "tempo.change.created");
    const proposed = list.find((e) => e.type === "loop.intent.proposed");

    if (created && proposed && proposed.at >= created.at) add("intent_shown", timed(created, proposed.at));
    const confirmed = list.find((e) => e.type === "loop.intent.confirmed");

    const proof = confirmed
      ? firstAfter(
          list,
          confirmed.at,
          (e) => e.type === "loop.proof.submitted" && e.payload["complete"] === true,
        )
      : undefined;

    if (confirmed && proof) add("preview_proof", timed(confirmed, proof.at));
  }

  for (const list of groupBy(input.events, (e) => str(e.payload, "intentId")).values()) {
    if (list.some((e) => e.type === "loop.intent.proposed"))
      add("intent_corrections", list.filter((e) => e.type === "loop.intent.corrected").length);
  }

  for (const [workspaceId, list] of byWorkspace) {
    const projectId = input.projects.get(workspaceId);
    const deploys = input.deploys.filter((d) => d.projectId === projectId);

    for (const merged of list.filter((e) => e.type === "tempo.pr.merged")) {
      const proof = list
        .filter(
          (e) => e.type === "loop.proof.submitted" && e.payload["complete"] === true && e.at <= merged.at,
        )
        .at(-1);

      if (proof) add("proof_to_merge", timed(proof, merged.at));

      const live = firstAfter(
        deploys,
        merged.at,
        (d) => d.type === "deploy.traffic.changed" && num(d.payload, "percentage") === 100,
      );

      const last = live
        ? deploys
            .filter(
              (d) =>
                d.deploymentId === live.deploymentId &&
                d.type === "deploy.traffic.changed" &&
                num(d.payload, "percentage") === 100,
            )
            .at(-1)
        : undefined;

      if (last) add("merge_to_live", last.at - merged.at);
    }

    for (const checks of groupBy(
      list.filter((e) => e.type === "tempo.check.passed" || e.type === "tempo.check.failed"),
      (e) => String(num(e.payload, "prNumber")),
    ).values()) {
      const final = checks.at(-1)!;

      if (final.type === "tempo.check.passed") add("ci", timed(checks[0]!, final.at));
    }
  }

  for (const d of input.deploys) {
    const requestedAt = num(d.payload, "requestedAt");

    if (d.type === "deploy.rolled_back" && d.payload["by"] === "owner" && requestedAt !== null)
      add("rollback", d.at - requestedAt);
    const occurredAt = num(d.payload, "occurredAt");

    if (d.type === "prod.error.seen" && occurredAt !== null && occurredAt <= d.at)
      add("error_seen", d.at - occurredAt);
  }

  for (const list of groupBy(
    input.deploys.filter((d) => d.type.startsWith("prod.error.")),
    (d) => str(d.payload, "errorId"),
  ).values()) {
    const seen = list.find((d) => d.type === "prod.error.seen");
    const fixed = seen ? firstAfter(list, seen.at, (d) => d.type === "prod.error.fixed") : undefined;

    if (seen && fixed) add("error_fixed", fixed.at - seen.at);
  }

  return samples;
};

export const loopResults = (input: LoopInput): StepResult[] =>
  [...loopSamples(input)].map(([step, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const target = LOOP_TARGETS.get(step)!;
    const median = percentile(sorted, 50);
    const p90 = percentile(sorted, 90);

    return {
      step,
      n: sorted.length,
      median,
      p90,
      targetMedian: target.median,
      targetP90: target.p90,
      met: median === null || p90 === null ? null : median <= target.median && p90 <= target.p90,
    };
  });

/** 13, Phase 3: contract violations in one workspace's loop events (sorted by time). */
export const contractViolations = (events: ReadonlyArray<LoopEvent>): string[] => {
  const out: string[] = [];

  for (const [changeId, list] of groupBy(events, (e) => e.changeId)) {
    const index = (type: string) => list.findIndex((e) => e.type === type);
    const proposed = index("loop.intent.proposed");
    const confirmed = index("loop.intent.confirmed");

    if (confirmed >= 0 && (proposed < 0 || proposed > confirmed))
      out.push(`${changeId}: loop.intent.confirmed without an earlier loop.intent.proposed`);

    if (proposed >= 0 && index("tempo.change.created") < 0)
      out.push(`${changeId}: loop.intent.proposed without tempo.change.created`);

    for (const e of list) {
      if (e.type === "loop.intent.proposed" && (num(e.payload, "lines") ?? 0) > 5)
        out.push(`${changeId}: intent longer than 5 lines`);
    }
  }

  return out;
};
