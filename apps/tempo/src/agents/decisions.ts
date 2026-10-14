import { Schema } from "effect";
import {
  ClefRequest,
  ClefResponse,
  type Agent,
  type AgentAttachment,
  type AttachmentHook,
  type LifecycleEvent,
} from "@tempo/protocol";
import { lifecycleRedactor } from "../agents/secrets.ts";
import { changeText, cutInput } from "./run-inputs.ts";
import { requireTempod } from "../do/workspace/container.ts";
import type { WorkspaceCore } from "../do/workspace/core.ts";
import type { Env } from "../env.ts";

export interface MatchedHook {
  readonly agent: Agent;
  readonly attachment: AgentAttachment;
  readonly hook: AttachmentHook;
  readonly index: number;
}

export interface HookDecision {
  readonly match: MatchedHook;
  readonly outcome: "run" | "skip" | "error";
  readonly p?: number;
}

export const decisionApi = {
  call: async (env: Env, input: ClefRequest): Promise<ClefResponse> => {
    if (!env.AI) throw new Error("Decision model is unavailable");

    return Schema.decodeUnknownSync(ClefResponse)(await env.AI.run("@cf/cloudflare/clef-flash", input));
  },
};

const redactValue = (value: Schema.Json, redact: (value: string) => string, limit = 4096): Schema.Json => {
  if (Schema.is(Schema.String)(value)) return cutInput(redact(value), limit);

  if (Array.isArray(value)) return value.map((v) => redactValue(v, redact, limit));

  if (Schema.is(Schema.JsonObject)(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, redact, limit)]));

  return value;
};

export const decisionState = async (
  core: WorkspaceCore,
  event: LifecycleEvent,
  mask?: (text: string) => string,
): Promise<string> => {
  const redact = mask ?? (await lifecycleRedactor(core));
  const text = event.changeId ? cutInput(redact(changeText(core, event.changeId)), 4096) : "";
  const origin = event.changeId ? core.lifecycle.origin(event.changeId) : null;
  const created = origin ? core.lifecycle.event(origin) : null;

  const files = (await requireTempod(core).request("git.changes", { scope: "branch" })).files
    .slice(0, 500)
    .map((f) => ({ path: cutInput(redact(f.path), 4096), added: f.additions, removed: f.deletions }));

  const checks =
    event.type === "tempo.check.failed" || event.type === "tempo.check.passed"
      ? Schema.decodeUnknownSync(Schema.Array(Schema.Json))(core.kv("checkRuns") ?? []).map((c) => {
          const check = Schema.decodeUnknownSync(
            Schema.Struct({ name: Schema.String, conclusion: Schema.NullOr(Schema.String) }),
          )(c);

          return {
            name: cutInput(redact(check.name), 4096),
            conclusion: check.conclusion ? redact(check.conclusion) : null,
          };
        })
      : [];

  const payload = redactValue(Schema.decodeUnknownSync(Schema.JsonObject)(event.payload), redact);

  let state: Schema.JsonObject = {
    event: { type: event.type, payload },
    change: { origin: created?.type === "tempo.change.created" ? created.payload.origin : "event", text },
    branch: cutInput(redact(core.ws().branch), 4096),
    files,
    checks,
  };

  if (event.runId) {
    const run = core.lifecycle.runs.row(event.runId);

    const result = run.resultJson
      ? Schema.decodeUnknownSync(Schema.Struct({ summary: Schema.String }))(JSON.parse(run.resultJson))
      : null;

    state = {
      ...state,
      run: {
        handle: redact(run.handle),
        status: run.status,
        summary: result ? cutInput(redact(result.summary), 4096) : "",
      },
    };
  }

  const bytes = () => new TextEncoder().encode(JSON.stringify(state)).length;

  while (bytes() > 32768 && files.length) files.pop();

  while (bytes() > 32768 && checks.length) checks.pop();

  if (
    bytes() > 32768 &&
    Schema.is(Schema.JsonObject)(payload) &&
    Schema.is(Schema.JsonObject)(payload.result)
  ) {
    const result = payload.result;

    for (const key of ["findings", "steps"]) {
      const values = result[key];

      if (Array.isArray(values)) while (bytes() > 32768 && values.length) values.pop();
    }
  }

  const json =
    bytes() > 32768 ? JSON.stringify(redactValue(state, (text) => text, 1024)) : JSON.stringify(state);

  Schema.decodeUnknownSync(ClefRequest)({ model: "clef-flash", state: json, questions: {} });

  return json;
};

export const DECISION_TIMEOUT_MS = 3000;

const callWithDeadline = async (env: Env, input: ClefRequest, timeoutMs: number): Promise<ClefResponse> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      decisionApi.call(env, input),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Decision timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export const decideHooks = async (
  env: Env,
  state: string,
  matches: ReadonlyArray<MatchedHook>,
  redact: (text: string) => string,
  timeoutMs = DECISION_TIMEOUT_MS,
): Promise<HookDecision[]> => {
  const decisions: HookDecision[] = matches.flatMap((match) =>
    match.hook.when === null ? [{ match, outcome: "run" as const }] : [],
  );

  const asked = matches.filter((m) => m.hook.when !== null);

  for (let offset = 0; offset < asked.length; offset += 64) {
    const group = asked.slice(offset, offset + 64);

    const questions = Object.fromEntries(
      group.map((m) => [
        `${m.attachment.id}.${m.index}`,
        { type: "noul" as const, instructions: redact(m.hook.when!) },
      ]),
    );

    let answer: ClefResponse | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const input = Schema.decodeUnknownSync(ClefRequest)({ model: "clef-flash", state, questions });

        const response = Schema.decodeUnknownSync(ClefResponse)(
          await callWithDeadline(env, input, timeoutMs),
        );

        if (Object.keys(questions).some((id) => !response.answers[id])) throw new Error("Missing answer");
        answer = response;
        break;
      } catch {
        /* A failed batch is retried once without logging model inputs. */
      }
    }

    for (const match of group) {
      const p = answer?.answers[`${match.attachment.id}.${match.index}`]?.noul;
      decisions.push(
        p === undefined
          ? { match, outcome: "error" }
          : { match, outcome: p >= match.hook.threshold ? "run" : "skip", p },
      );
    }
  }

  return decisions.toSorted((a, b) => matches.indexOf(a.match) - matches.indexOf(b.match));
};
