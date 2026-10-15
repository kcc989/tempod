import { Schema } from "effect";
import { and, eq, lt } from "drizzle-orm";
import { TempoError, type FnInput, type FnOutput } from "@tempo/protocol";
import { projects, workspaces } from "../../db/d1.ts";
import { contractViolations, loopResults, type DeployEvent, type LoopEvent } from "../../loop/report.ts";
import type { HandlerCtx } from "../run.ts";
import { d1 } from "./common.ts";

/** The longest window one report reads. */
export const LOOP_REPORT_MAX_MS = 31 * 86_400_000;

const payload = (json: string): Schema.JsonObject => {
  const value: Schema.Json = JSON.parse(json);

  return Schema.is(Schema.JsonObject)(value) ? value : {};
};

/** 13, L-ADR-7: `getLoopReport {from, to}` over the owner's workspaces and projects. */
export const getLoopReport = async (
  { env, user }: HandlerCtx,
  { from, to }: FnInput<"getLoopReport">,
): Promise<FnOutput<"getLoopReport">> => {
  if (!(from < to) || to - from > LOOP_REPORT_MAX_MS)
    throw new TempoError("VALIDATION_FAILED", undefined, "The window must be 1 ms to 31 days.");
  const db = d1(env);

  const [rows, owned] = await Promise.all([
    db
      .select({ id: workspaces.id, projectId: workspaces.projectId })
      .from(workspaces)
      .where(and(eq(workspaces.userId, user.id), lt(workspaces.createdAt, to)))
      .all(),
    db.select({ id: projects.id }).from(projects).where(eq(projects.userId, user.id)).all(),
  ]);

  const events: LoopEvent[] = [];
  const violations: string[] = [];

  for (const w of rows) {
    const list = (await env.WORKSPACE.getByName(w.id).loopEvents(from, to)).map((e): LoopEvent => ({
      workspaceId: w.id,
      changeId: e.changeId,
      type: e.type,
      at: e.at,
      payload: payload(e.payloadJson),
    }));

    events.push(...list);
    violations.push(...contractViolations(list).map((v) => `${w.id}/${v}`));
  }

  const deploys: DeployEvent[] = [];

  for (const p of owned) {
    for (const e of await env.APP_DEPLOY.getByName(p.id).loopEvents(from, to))
      deploys.push({
        projectId: p.id,
        deploymentId: e.deploymentId,
        type: e.type,
        at: e.at,
        payload: payload(e.payloadJson),
      });
  }

  events.sort((a, b) => a.at - b.at);

  return {
    from,
    to,
    steps: loopResults({ events, deploys, projects: new Map(rows.map((w) => [w.id, w.projectId])) }),
    violations,
  };
};
