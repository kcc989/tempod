import { env, runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import * as loop from "../../src/server/handlers/loop.ts";
import { loopReportKey, runDailyLoopReport } from "../../src/loop/daily.ts";
import type { HandlerCtx } from "../../src/server/run.ts";
import { internals, sqlRows } from "./fakes.ts";
import { seedReadyWorkspace } from "./ready-fixture.ts";
import {
  activeTime,
  contractViolations,
  loopResults,
  percentile,
  type DeployEvent,
  type LoopEvent,
} from "../../src/loop/report.ts";

const MIN = 60_000;

const ev = (type: string, at: number, extra: Partial<LoopEvent> = {}): LoopEvent => ({
  workspaceId: "w1",
  changeId: "c1",
  type,
  at,
  payload: {},
  ...extra,
});

const dep = (
  type: string,
  at: number,
  payload: DeployEvent["payload"],
  deploymentId = "d1",
): DeployEvent => ({
  projectId: "p1",
  deploymentId,
  type,
  at,
  payload,
});

describe("loop report (13, Targets)", () => {
  it("takes nearest-rank percentiles and drops idle gaps of more than 30 minutes", ({ expect }) => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([], 50)).toBeNull();
    expect(activeTime([10 * MIN], 0, 20 * MIN)).toBe(20 * MIN);
    expect(activeTime([10 * MIN], 0, 80 * MIN)).toBe(10 * MIN);
  });

  it("measures each step from the events and compares it with the target", ({ expect }) => {
    const intent = { intentId: "i1", lines: 3 };

    const events: LoopEvent[] = [
      ev("tempo.change.created", 0),
      ev("loop.intent.proposed", 2 * MIN, { payload: intent }),
      ev("loop.intent.corrected", 3 * MIN, { payload: { intentId: "i1" } }),
      ev("loop.intent.confirmed", 4 * MIN, { payload: intent }),
      ev("loop.proof.submitted", 10 * MIN, { payload: { proofId: "p", complete: false } }),
      ev("loop.proof.submitted", 14 * MIN, { payload: { proofId: "q", complete: true } }),
      ev("tempo.check.failed", 15 * MIN, { changeId: null, payload: { prNumber: 4 } }),
      ev("tempo.check.passed", 20 * MIN, { changeId: null, payload: { prNumber: 4 } }),
      ev("tempo.pr.merged", 24 * MIN, { changeId: null, payload: { prNumber: 4 } }),
    ];

    const deploys = [
      dep("deploy.traffic.changed", 30 * MIN, { percentage: 10 }),
      dep("deploy.traffic.changed", 40 * MIN, { percentage: 100, worker: "a" }),
      dep("deploy.traffic.changed", 41 * MIN, { percentage: 100, worker: "b" }),
      dep("deploy.rolled_back", 50 * MIN + 20_000, { by: "owner", requestedAt: 50 * MIN }),
      dep("prod.error.seen", 60 * MIN, { errorId: "e1", occurredAt: 58 * MIN }),
      dep("prod.error.fixed", 100 * MIN, { errorId: "e1" }),
    ];

    const results = new Map(
      loopResults({ events, deploys, projects: new Map([["w1", "p1"]]) }).map((r) => [r.step, r]),
    );

    expect(Object.fromEntries([...results].map(([k, r]) => [k, r.median]))).toEqual({
      intent_shown: 2 * MIN,
      intent_corrections: 1,
      preview_proof: 10 * MIN,
      proof_to_merge: 10 * MIN,
      ci: 5 * MIN,
      merge_to_live: 17 * MIN,
      rollback: 20_000,
      error_seen: 2 * MIN,
      error_fixed: 40 * MIN,
    });
    expect(results.get("proof_to_merge")).toMatchObject({ n: 1, met: true });
    expect(loopResults({ events: [], deploys: [], projects: new Map() })[0]).toMatchObject({
      n: 0,
      met: null,
    });
  });

  it("reports events out of order and intents longer than 5 lines", ({ expect }) => {
    expect(
      contractViolations([
        ev("tempo.change.created", 0),
        ev("loop.intent.proposed", 1, { payload: { lines: 3 } }),
        ev("loop.intent.confirmed", 2),
      ]),
    ).toEqual([]);
    expect(
      contractViolations([
        ev("loop.intent.confirmed", 1),
        ev("loop.intent.proposed", 2, { payload: { lines: 6 } }),
      ]),
    ).toEqual([
      "c1: loop.intent.confirmed without an earlier loop.intent.proposed",
      "c1: loop.intent.proposed without tempo.change.created",
      "c1: intent longer than 5 lines",
    ]);
  });

  it("writes tempo.pr.merged once and reports the owner's steps from the event log", async ({ expect }) => {
    const w = await seedReadyWorkspace();
    await sqlRows(w.stub, "UPDATE workspace SET pr_number = 7, pr_state = 'open'");
    await runInDurableObject(w.stub, (instance: WorkspaceDO) => {
      const { core } = internals(instance);

      core.lifecycle.append({
        type: "loop.proof.submitted",
        source: "agent",
        dedupeKey: "proof:test",
        payload: { proofId: "01k700000000000000000000zz", complete: true },
      });
      core.updateWs({ prState: "merged" });
      core.updateWs({ prState: "merged" });
    });

    const merged = await sqlRows(
      w.stub,
      "SELECT payload_json FROM lifecycle_events WHERE type = 'tempo.pr.merged'",
    );

    expect(merged.map((m) => JSON.parse(String(m["payload_json"])))).toEqual([{ prNumber: 7 }]);

    const ctx: HandlerCtx = {
      env,
      user: { id: w.seeded.userId, name: "Owner", email: "o@example.com", image: null },
    };

    const now = Date.now();
    const report = await loop.getLoopReport(ctx, { from: now - 3_600_000, to: now + 60_000 });

    expect(report.steps.find((s) => s.step === "proof_to_merge")).toMatchObject({ n: 1, met: true });
    expect(report.violations).toEqual([]);
    await expect(loop.getLoopReport(ctx, { from: now, to: now })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("stores the daily report and opens one issue for a step missed two days in a row", async ({
    expect,
  }) => {
    const w = await seedReadyWorkspace();
    await env.DB.prepare(
      "UPDATE projects SET provider='artifacts',installation_id=NULL,repo_id=NULL,artifact_repo_id='repo-loop',clone_url='https://x.artifacts.cloudflare.net/git/r/loop.git' WHERE id=?",
    )
      .bind(w.seeded.projectId)
      .run();
    const now = Date.now() + 60_000;
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

    const row = (type: string, at: number) =>
      sqlRows(
        w.stub,
        "INSERT INTO lifecycle_events (id, type, source, occurred_at, change_id, dedupe_key, payload_json) VALUES (?, ?, 'tempo', ?, 'c1', ?, ?)",
        `${type}-${at}`,
        type,
        at,
        `${type}-${at}`,
        JSON.stringify({ intentId: "i1", lines: 2 }),
      );

    await row("tempo.change.created", now - 20 * MIN);
    await row("loop.intent.proposed", now - 10 * MIN);

    const missed = {
      step: "intent_shown",
      n: 1,
      median: 600_000,
      p90: 600_000,
      targetMedian: MIN,
      targetP90: 3 * MIN,
      met: false,
    };

    await env.DATA.put(
      loopReportKey(day(now - 86_400_000)),
      JSON.stringify({ from: 0, to: 1, steps: [missed], violations: [] }),
    );

    expect(await runDailyLoopReport(env, now, w.seeded.userId)).toEqual(["intent_shown"]);

    const stored = await (await env.DATA.get(loopReportKey(day(now))))!.json<{
      steps: { step: string; met: boolean | null }[];
    }>();

    expect(stored.steps.find((x) => x.step === "intent_shown")?.met).toBe(false);
    expect(await runDailyLoopReport(env, now + 60_000, w.seeded.userId)).toEqual([]);

    const issues = await env.DB.prepare("SELECT title FROM issues WHERE project_id = ?")
      .bind(w.seeded.projectId)
      .all();

    expect(issues.results.map((r) => r["title"])).toEqual(["Loop target missed: intent_shown"]);
  });
});
