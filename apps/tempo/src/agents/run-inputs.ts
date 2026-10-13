import { and, asc, desc, eq } from "drizzle-orm";
import { type AgentDefinition, type ContentBlock } from "@tempo/protocol";
import { runs, turns, type RunRow } from "../db/workspace-do.ts";
import { EMPTY_PROMPT, json } from "../db/json.ts";
import { CheckRun } from "@tempo/protocol";
import { Schema } from "effect";
import { cutInput } from "../roles/inputs.ts";
import type { WorkspaceCore } from "../do/workspace/core.ts";
import { requireTempod } from "../do/workspace/container.ts";

export { cutInput } from "../roles/inputs.ts";

export const RUN_ACCESS_TEXT = {
  "read-only":
    "This agent is read-only. Do not create, change, move or delete files under /workspace, and do not run commands that do, such as formatters, code generators or git commands that change the branch. You may read files and run commands that only read. Tempo compares the files before and after each turn and shows a warning if they differ.",
  write:
    "This agent may change files under /workspace. Do not commit, push or change the branch. Tempo does that.",
};

export const RUN_OUTPUT_TEXT = {
  plan: 'When you finish, call the report_result tool once with a status of "done" or "blocked", a summary, and the plan as steps. Do not end your turn before you call it.',
  review:
    'When you finish, call the report_result tool once with a status of "pass", "fail" or "blocked", a summary, and each problem as a finding. Mark a finding blocking when the change must not merge with it. Do not end your turn before you call it.',
  note: 'When you finish, call the report_result tool once with a status of "done" or "blocked" and a summary. Do not end your turn before you call it.',
};

export const RUN_FOLLOW_UP =
  "Tempo did not get your result. Finish the work if it is not complete, call the report_result tool, then end your turn.";

export const changeText = (core: WorkspaceCore, changeId: string): string => {
  const origin = core.lifecycle.origin(changeId);
  const request = origin ? core.lifecycle.event(origin) : null;

  if (request?.type === "tempo.change.created" && request.payload.text) return request.payload.text;

  const turn = core.db
    .select()
    .from(turns)
    .where(and(eq(turns.changeId, changeId), eq(turns.origin, "user")))
    .orderBy(asc(turns.seq))
    .get();

  return turn ? json.prompt.read(turn.promptJson, EMPTY_PROMPT).text : "";
};

export const runInputs = async (
  core: WorkspaceCore,
  definition: AgentDefinition,
  run: RunRow,
): Promise<ContentBlock[]> => {
  const event = core.lifecycle.event(core.lifecycle.row(run.triggerEventId)!);

  const parts = [
    `You are running as the Tempo agent "${definition.name}" for this change: ${definition.description}`,
    RUN_ACCESS_TEXT[definition.access],
    RUN_OUTPUT_TEXT[definition.outputKind],
  ];

  const prompt = changeText(core, run.changeId);

  if (prompt) parts.push(prompt);

  if (!(event.type === "tempo.change.created" && event.payload.origin === "prompt")) {
    const tempod = requireTempod(core);
    const changes = await tempod.request("git.changes", { scope: "branch" });
    const diff = [JSON.stringify(changes)];
    let bytes = new TextEncoder().encode(diff[0]).length;

    for (const file of changes.files) {
      if (bytes >= 256 * 1024) break;
      const value = await tempod.request("git.fileDiff", { scope: "branch", path: file.path });
      diff.push(value.diff);
      bytes += new TextEncoder().encode(value.diff).length;
    }

    parts.push(diff.join("\n"));
  }

  if (event.type.startsWith("run.") || definition.outputKind === "review") {
    const latest = new Map<string, string>();

    for (const other of core.db
      .select()
      .from(runs)
      .where(and(eq(runs.changeId, run.changeId), eq(runs.status, "completed")))
      .orderBy(desc(runs.endedAt), desc(runs.id))
      .all()) {
      if (other.handle !== run.handle && other.resultJson && !latest.has(other.handle))
        latest.set(other.handle, other.resultJson);
    }

    parts.push(JSON.stringify(Object.fromEntries(latest)));
  }

  if (event.type === "tempo.check.failed")
    parts.push(
      JSON.stringify(
        Schema.decodeUnknownSync(Schema.Array(CheckRun))(core.kv("checkRuns") ?? []).filter(
          (check) => check.conclusion && !["success", "neutral", "skipped"].includes(check.conclusion),
        ),
      ),
    );
  let remaining = 512 * 1024;

  return parts.map((part) => {
    const text = cutInput(part, Math.min(256 * 1024, remaining));
    remaining -= new TextEncoder().encode(text).length;

    return { type: "text", text };
  });
};

export const sentResultText = (
  name: string,
  outputKind: string,
  result: import("@tempo/protocol").RunResult,
): string => {
  if (outputKind === "plan")
    return [
      `Implement this plan from ${name}:`,
      result.summary,
      ...(result.steps ?? []).map(
        (s, i) => `${i + 1}. ${s.text}${s.files?.length ? ` (${s.files.join(", ")})` : ""}`,
      ),
      ...(result.verify ? [result.verify] : []),
    ].join("\n");

  if (outputKind === "review")
    return [
      `Fix these findings from ${name}:`,
      ...(result.findings ?? []).filter((f) => f.blocking).map((f) => `${f.path}:${f.line ?? ""} ${f.text}`),
      result.summary,
    ].join("\n");

  return `Result from ${name}:\n${result.summary}`;
};
