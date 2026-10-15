import { Schema } from "effect";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { LoopReport } from "@tempo/protocol";
import { createArtifactIssue } from "../artifacts/issues.ts";
import * as schema from "../db/d1.ts";
import type { Env } from "../env.ts";
import { errorText, log } from "../log.ts";
import { getLoopReport } from "../server/handlers/loop.ts";

const DAY = 86_400_000;

/** 13, Phase 3: the daily report reads the 7 days before it runs. */
export const LOOP_WINDOW_MS = 7 * DAY;

/** A missed step opens at most one issue a week. */
const ISSUE_EVERY_MS = 7 * DAY;

export const loopReportKey = (date: string) => `loop/${date}.json`;

const issueKey = (step: string) => `loop/issues/${step}.json`;

const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const minutes = (step: string, v: number | null) =>
  v === null ? "none" : step === "intent_corrections" ? String(v) : `${(v / 60_000).toFixed(1)} min`;

const readReport = async (env: Env, key: string) => {
  const obj = await env.DATA.get(key);

  const value: Schema.Json | undefined = obj ? await obj.json() : undefined;

  return Schema.is(LoopReport)(value) ? value : undefined;
};

/** The owner: the user whose GitHub account is TEMPO_OWNER_GITHUB_ID (05). */
const ownerUser = async (env: Env) =>
  drizzle(env.DB, { schema })
    .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
    .from(schema.account)
    .innerJoin(schema.user, eq(schema.user.id, schema.account.userId))
    .where(
      and(eq(schema.account.providerId, "github"), eq(schema.account.accountId, env.TEMPO_OWNER_GITHUB_ID)),
    )
    .get();

/**
 * 13, Phase 3, Time checks: writes `loop/<date>.json` and opens a Tempo issue in the owner's first
 * native project for each step that missed its target in this report and the one before.
 */
export const runDailyLoopReport = async (env: Env, now: number, userId?: string): Promise<string[]> => {
  const owner = userId
    ? await drizzle(env.DB, { schema }).select().from(schema.user).where(eq(schema.user.id, userId)).get()
    : await ownerUser(env);

  if (!owner) return [];
  const user = { id: owner.id, name: owner.name, email: owner.email, image: null };
  const report = await getLoopReport({ env, user }, { from: now - LOOP_WINDOW_MS, to: now });
  await env.DATA.put(loopReportKey(dateOf(now)), JSON.stringify(report));
  const previous = await readReport(env, loopReportKey(dateOf(now - DAY)));

  if (!previous) return [];

  const missed = report.steps.filter(
    (s) => s.met === false && previous.steps.some((p) => p.step === s.step && p.met === false),
  );

  if (missed.length === 0) return [];

  const project = await drizzle(env.DB, { schema })
    .select()
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.userId, owner.id),
        eq(schema.projects.provider, "artifacts"),
        isNotNull(schema.projects.artifactRepoId),
      ),
    )
    .orderBy(asc(schema.projects.sortOrder))
    .get();

  if (!project) return [];
  const opened: string[] = [];

  for (const s of missed) {
    const last = await env.DATA.get(issueKey(s.step));
    const lastAt = last ? Number(await last.text()) : 0;

    if (now - lastAt < ISSUE_EVERY_MS) continue;

    try {
      await createArtifactIssue(env, project, owner.id, {
        title: `Loop target missed: ${s.step}`,
        body: [
          `The loop step \`${s.step}\` missed its target in the last two daily reports (13, Targets).`,
          "",
          `- Window: ${new Date(report.from).toISOString()} to ${new Date(report.to).toISOString()}`,
          `- Samples: ${s.n}`,
          `- Median: ${minutes(s.step, s.median)} (target ${minutes(s.step, s.targetMedian)})`,
          `- p90: ${minutes(s.step, s.p90)} (target ${minutes(s.step, s.targetP90)})`,
          `- Report: \`${loopReportKey(dateOf(now))}\` in R2; the events are the lifecycle and deploy events of 13, L-ADR-7 in this window.`,
        ].join("\n"),
      });
      await env.DATA.put(issueKey(s.step), String(now));
      opened.push(s.step);
    } catch (e) {
      log("warn", "loop issue failed", { step: s.step, error: errorText(e) });
    }
  }

  return opened;
};
