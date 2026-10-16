import { Schema } from "effect";
import { and, desc, eq, isNull } from "drizzle-orm";
import { parseProfile, type ProfileCheck } from "@tempo/settings";
import { TempoError, newId, type ChecklistItem, type ProofContent } from "@tempo/protocol";
import {
  artifacts,
  checklist,
  items,
  proofs,
  type ChecklistRow,
  type ProofRow,
  type SessionRow,
  type ScriptRunRow,
} from "../../db/workspace-do.ts";
import { errorText, log } from "../../log.ts";
import { requireTempod } from "./container.ts";
import type { WorkspaceCore } from "./core.ts";
import { startScript } from "./scripts.ts";

/** 13, L-ADR-2: exact texts. */
export const PROOF_TEXT = {
  answer: "Tempo is running the checks. End your turn; the owner sees the proof when they finish.",
  tooLong: "Summary must be at most 5 lines.",
  lineTooLong: "Each line must be at most 160 characters.",
  publishFirst: (path: string) => `Publish ${path} with publish_artifact first.`,
  unknownItem: (id: string) => `Unknown checklist item ${id}.`,
  checklistHeader: "Open design checklist:",
} as const;

export const CHECK_PREFIX = "check:";

const LIMITS = { lines: 5, lineChars: 160, screens: 20, checklist: 50, noteChars: 500, textChars: 2000 };

const ProofInput = Schema.Struct({
  summary: Schema.String.check(Schema.isMinLength(1)),
  screens: Schema.Array(
    Schema.Struct({
      route: Schema.String.check(Schema.isMinLength(1)),
      viewport: Schema.Literals(["desktop", "phone"]),
      theme: Schema.Literals(["light", "dark"]),
      image: Schema.String.check(Schema.isMinLength(1)),
      recording: Schema.optional(Schema.String),
    }),
  ).check(Schema.isMaxLength(LIMITS.screens)),
  checklist: Schema.Array(
    Schema.Struct({
      itemId: Schema.String,
      note: Schema.String.check(Schema.isMaxLength(LIMITS.noteChars)),
    }),
  ).check(Schema.isMaxLength(LIMITS.checklist)),
});

type Check = ProofContent["checks"][number];

type Missing = { readonly routes: string[]; readonly checklist: string[] };

const GLOB_PARTS = new Map([
  ["**/", "(?:.*/)?"],
  ["**", ".*"],
  ["*", "[^/]*"],
]);

/** `*` matches within one path segment, `**` across segments. */
export const globMatches = (glob: string, path: string): boolean => {
  const source = glob
    .split(/(\*\*\/?|\*)/)
    .map((part) => GLOB_PARTS.get(part) ?? part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("");

  return new RegExp(`^${source}$`).test(path);
};

const workspacePath = (path: string) => (path.startsWith("/") ? path : `/workspace/${path}`);

const publishedArtifact = (core: WorkspaceCore, sessionId: string, path: string) => {
  const r = core.db
    .select({ id: artifacts.id, version: artifacts.version })
    .from(artifacts)
    .where(and(eq(artifacts.sessionId, sessionId), eq(artifacts.path, workspacePath(path))))
    .orderBy(desc(artifacts.version))
    .get();

  if (!r) throw new TempoError("VALIDATION_FAILED", PROOF_TEXT.publishFirst(path));

  return r;
};

const read = <T>(text: string): T =>
  // SAFETY: proof JSON columns are written only by this module.
  JSON.parse(text) as T;

export const checklistToWire = (r: ChecklistRow): ChecklistItem => ({
  id: r.id,
  text: r.text,
  status: r.status,
  sourceItemId: r.sourceItemId,
  resolvedBy: r.resolvedBy,
  createdAt: r.createdAt,
});

export const listChecklist = (core: WorkspaceCore): ChecklistItem[] =>
  core.db.select().from(checklist).orderBy(checklist.createdAt, checklist.id).all().map(checklistToWire);

const openChecklist = (core: WorkspaceCore): ChecklistRow[] =>
  core.db.select().from(checklist).where(eq(checklist.status, "open")).orderBy(checklist.createdAt).all();

/** The prompt block for open checklist items, or null when none are open. */
export const checklistBlock = (core: WorkspaceCore): string | null => {
  const open = openChecklist(core);

  return open.length
    ? [PROOF_TEXT.checklistHeader, ...open.map((r) => `${r.id}: ${r.text}`)].join("\n")
    : null;
};

const statusOf = (complete: number | null): ProofContent["status"] => {
  if (complete === null) return "checking";

  return complete === 1 ? "complete" : "incomplete";
};

const proofContent = (r: ProofRow): ProofContent => {
  const checks = read<Check[]>(r.checksJson);
  const missing = read<Missing>(r.missingJson);

  return {
    proofId: r.id,
    summary: r.summary,
    screens: read<ProofContent["screens"]>(r.screensJson),
    checks,
    resolved: read<ProofContent["resolved"]>(r.checklistJson),
    missingRoutes: missing.routes,
    missingChecklist: missing.checklist,
    status: statusOf(r.complete),
  };
};

const changedRoutes = async (
  core: WorkspaceCore,
  screens: ReadonlyArray<{ route: string; files: ReadonlyArray<string> }>,
) => {
  if (screens.length === 0) return [];
  const res = await requireTempod(core).request("git.changes", { scope: "branch" });
  const paths = res.files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path]));

  return screens.flatMap((s) => (paths.some((p) => s.files.some((g) => globMatches(g, p))) ? [s.route] : []));
};

const profileOf = async (core: WorkspaceCore) => {
  const res = await core.env.APP_DEPLOY.getByName(core.ws().projectId).getProfile();

  if (!res.ok) throw new TempoError(res.error.code, res.error.message, res.error.detail);

  return parseProfile(res.value.source);
};

const startCheck = async (core: WorkspaceCore, check: ProfileCheck): Promise<Check> => {
  try {
    const run = await startScript(core, {
      kind: "run",
      scriptId: `${CHECK_PREFIX}${check.name}`,
      command: check.command,
      cwd: "/workspace",
      timeoutMs: check.timeoutMinutes * 60_000,
    });

    return run.status === "running"
      ? { name: check.name, runId: run.id, status: "running", exitCode: null }
      : { name: check.name, runId: run.id, status: "failed", exitCode: run.exitCode };
  } catch (e) {
    log("warn", "proof check did not start", { workspaceId: core.workspaceId, error: errorText(e) });

    return { name: check.name, runId: null, status: "failed", exitCode: null };
  }
};

/** The `submit_proof` tool. Returns the tool's answer text. */
export const submitProof = async (
  core: WorkspaceCore,
  session: SessionRow,
  params: Schema.Json,
): Promise<string> => {
  const input = Schema.decodeUnknownSync(ProofInput)(params);
  const lines = input.summary.trim().split("\n");

  if (lines.length > LIMITS.lines) throw new TempoError("VALIDATION_FAILED", PROOF_TEXT.tooLong);

  if (lines.some((l) => l.length > LIMITS.lineChars))
    throw new TempoError("VALIDATION_FAILED", PROOF_TEXT.lineTooLong);

  for (const c of input.checklist) {
    if (!core.db.select({ id: checklist.id }).from(checklist).where(eq(checklist.id, c.itemId)).get())
      throw new TempoError("VALIDATION_FAILED", PROOF_TEXT.unknownItem(c.itemId));
  }

  const screens = input.screens.map((s) => {
    const image = publishedArtifact(core, session.id, s.image);

    return {
      route: s.route,
      viewport: s.viewport,
      theme: s.theme,
      artifactId: image.id,
      version: image.version,
      recordingArtifactId: s.recording ? publishedArtifact(core, session.id, s.recording).id : null,
    };
  });

  const profile = await profileOf(core);
  const required = await changedRoutes(core, profile?.screens ?? []);
  const named = new Set(input.checklist.map((c) => c.itemId));

  const missing: Missing = {
    routes: required.filter((r) => !screens.some((s) => s.route === r)),
    checklist: openChecklist(core)
      .map((r) => r.id)
      .filter((id) => !named.has(id)),
  };

  const running = core.runningTurn();
  const id = newId();

  core.db
    .insert(proofs)
    .values({
      id,
      sessionId: session.id,
      changeId: running?.changeId ?? null,
      itemId: null,
      summary: input.summary.trim(),
      screensJson: JSON.stringify(screens),
      checklistJson: JSON.stringify(input.checklist.map((c) => ({ checklistId: c.itemId, note: c.note }))),
      checksJson: "[]",
      missingJson: JSON.stringify(missing),
      complete: null,
      createdAt: Date.now(),
    })
    .run();

  const item = core.insertItem({
    sessionId: session.id,
    turnId: running?.sessionId === session.id ? running.id : null,
    kind: "proof",
    status: "in_progress",
    content: proofContent(proofRow(core, id)),
  });

  core.db.update(proofs).set({ itemId: item.id }).where(eq(proofs.id, id)).run();
  const checks: Check[] = [];

  for (const check of profile?.checks ?? []) checks.push(await startCheck(core, check));
  core.db
    .update(proofs)
    .set({ checksJson: JSON.stringify(checks) })
    .where(eq(proofs.id, id))
    .run();
  settle(core, id);

  return PROOF_TEXT.answer;
};

const proofRow = (core: WorkspaceCore, id: string): ProofRow => {
  const r = core.db.select().from(proofs).where(eq(proofs.id, id)).get();

  if (!r) throw new TempoError("NOT_FOUND");

  return r;
};

/** Ends the proof when no check is running: decides `complete` and resolves its checklist items. */
const settle = (core: WorkspaceCore, id: string): void => {
  const r = proofRow(core, id);
  const checks = read<Check[]>(r.checksJson);

  if (r.complete === null && checks.every((c) => c.status !== "running")) {
    const missing = read<Missing>(r.missingJson);

    const complete =
      missing.routes.length === 0 &&
      missing.checklist.length === 0 &&
      checks.every((c) => c.status === "passed");

    core.ctx.storage.transactionSync(() => {
      core.db
        .update(proofs)
        .set({ complete: complete ? 1 : 0 })
        .where(and(eq(proofs.id, id), isNull(proofs.complete)))
        .run();

      if (complete) {
        for (const c of read<ProofContent["resolved"]>(r.checklistJson))
          core.db
            .update(checklist)
            .set({ status: "resolved", resolvedBy: id })
            .where(and(eq(checklist.id, c.checklistId), eq(checklist.status, "open")))
            .run();
      }
    });
    core.lifecycle.append({
      type: "loop.proof.submitted",
      source: "agent",
      changeId: r.changeId ?? undefined,
      sessionId: r.sessionId,
      dedupeKey: `proof:${id}:submitted`,
      payload: { proofId: id, complete },
    });
    core.lifecycle.kick();
    core.broadcastDetailSoon();
  }

  const fresh = proofRow(core, id);

  if (fresh.itemId)
    core.updateItem(fresh.itemId, {
      status: fresh.complete === null ? "in_progress" : "completed",
      content: proofContent(fresh),
    });
};

/** Called when a script run ends: records a check result on the proof that started it. */
export const onCheckExited = (core: WorkspaceCore, run: ScriptRunRow): void => {
  if (!run.scriptId?.startsWith(CHECK_PREFIX)) return;

  for (const r of core.db.select().from(proofs).where(isNull(proofs.complete)).all()) {
    const checks = read<Check[]>(r.checksJson);

    if (!checks.some((c) => c.runId === run.id)) continue;
    const passed = run.status === "exited" && run.exitCode === 0;

    const next = checks.map((c): Check =>
      c.runId === run.id ? { ...c, status: passed ? "passed" : "failed", exitCode: run.exitCode } : c,
    );

    core.db
      .update(proofs)
      .set({ checksJson: JSON.stringify(next) })
      .where(eq(proofs.id, r.id))
      .run();
    settle(core, r.id);
  }
};

/** `addChecklistItem`: the text of a user message becomes an open item. A repeat returns the same item. */
export const addChecklistItem = (core: WorkspaceCore, itemId: string): ChecklistItem => {
  const existing = core.db.select().from(checklist).where(eq(checklist.sourceItemId, itemId)).get();

  if (existing) return checklistToWire(existing);
  const source = core.db.select().from(items).where(eq(items.id, itemId)).get();

  if (!source || source.kind !== "user_message") throw new TempoError("NOT_FOUND");

  const content = Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(
    JSON.parse(source.contentJson),
  );

  const text = content.text.trim();

  if (text.length === 0 || text.length > LIMITS.textChars)
    throw new TempoError(
      "VALIDATION_FAILED",
      `The checklist text must be 1 to ${LIMITS.textChars} characters.`,
    );
  const id = newId();

  core.db
    .insert(checklist)
    .values({ id, text, status: "open", sourceItemId: itemId, resolvedBy: null, createdAt: Date.now() })
    .run();
  core.lifecycle.append({
    type: "loop.checklist.added",
    source: "tempo",
    sessionId: source.sessionId,
    dedupeKey: `checklist:${id}:added`,
    payload: { checklistId: id },
  });
  core.lifecycle.kick();
  core.broadcastDetailSoon();

  return checklistToWire(core.db.select().from(checklist).where(eq(checklist.id, id)).get()!);
};

/** `reopenChecklistItem`. Reopening an open item does nothing. */
export const reopenChecklistItem = (core: WorkspaceCore, checklistId: string): void => {
  const r = core.db.select().from(checklist).where(eq(checklist.id, checklistId)).get();

  if (!r) throw new TempoError("NOT_FOUND");

  if (r.status === "open") return;
  core.db.update(checklist).set({ status: "open", resolvedBy: null }).where(eq(checklist.id, r.id)).run();
  core.lifecycle.append({
    type: "loop.checklist.reopened",
    source: "tempo",
    dedupeKey: `checklist:${r.id}:reopened:${newId()}`,
    payload: { checklistId: r.id },
  });
  core.lifecycle.kick();
  core.broadcastDetailSoon();
};
