import {
  TypeSafeClient,
  noul,
  score,
  type Fetch,
  type JsonValue,
  type TypeSafeClientConfig,
} from "@typesafe-ai/sdk";
import type { Env } from "../env.ts";

/** 13, L-ADR-9. */
export const JEV_MODEL = "jev-1.14.0";

export const JEV_TIMEOUT_MS = 10_000;

/** The owner's TypeSafe AI key in CredentialDO. It never leaves the Worker. */
export const TYPESAFE_KEY = "typesafe.api_key";

const ROLLBACK = ["Easy to undo", "Hard to undo", "Cannot be undone"] as const;

/** A noul at or above this, or a score at or above the middle level, is high. */
const HIGH_NOUL = 0.5;

const HIGH_SCORE = 1;

export type JudgeReason = "new_access" | "security_risk" | "hard_rollback" | "not_aligned" | "no_answer";

export interface Judgement {
  readonly high: boolean;
  readonly reasons: ReadonlyArray<JudgeReason>;
  /** Raw answers, keyed by question id, for the event that records the check. */
  readonly answers: Readonly<Record<string, number>>;
  readonly model: string | null;
}

export type Intent = {
  readonly goal: string;
  readonly approach: string;
  readonly notDoing: string;
};

export type CloudflareCall = {
  readonly method: string;
  readonly path: string;
  readonly resource: string;
};

export type Judge = Pick<TypeSafeClient, "systemOne">;

export const jevClient = (apiKey: string, fetch?: Fetch): Judge => {
  const config: TypeSafeClientConfig = {
    apiKey,
    defaultModel: JEV_MODEL,
    timeout: JEV_TIMEOUT_MS,
    retry: { maxRetries: 1 },
    compression: false,
    logLevel: "off",
  };

  if (fetch) config.fetch = fetch;

  return new TypeSafeClient(config);
};

/** The owner's judge, or null when no key is set. Without a judge every check is high. */
export const ownerJudge = async (env: Env, userId: string): Promise<Judge | null> => {
  const key = await env.CREDENTIALS.getByName(userId).getSecret(TYPESAFE_KEY);

  return key ? jevClient(key) : null;
};

const pick = (checks: ReadonlyArray<readonly [JudgeReason, boolean]>): JudgeReason[] =>
  checks.flatMap(([reason, hit]) => (hit ? [reason] : []));

const noAnswer: Judgement = { high: true, reasons: ["no_answer"], answers: {}, model: null };

/** Intent risk (13, L-ADR-1 step 6). Any high answer, or no answer, means the owner confirms. */
export const judgeIntent = async (
  judge: Judge | null,
  intent: Intent,
  context: JsonValue,
): Promise<Judgement> => {
  if (!judge) return noAnswer;

  try {
    const { answers, model } = await judge.systemOne({
      state: { intent, context },
      questions: {
        new_access: noul("Does this work need a permission or access right that is not granted now?", {
          true: "A new API token scope, credential, secret, binding to another account, role, or access for another person or service",
          false: "Only product features, code and data inside access that already exists",
        }),
        security_risk: noul(
          "Does this work add a security risk, such as exposing data, secrets or an unauthenticated route?",
        ),
        hard_rollback: score("How hard is it to undo this work once it is deployed?", [...ROLLBACK]),
      },
    });

    const reasons = pick([
      ["new_access", answers.new_access.noul >= HIGH_NOUL],
      ["security_risk", answers.security_risk.noul >= HIGH_NOUL],
      ["hard_rollback", answers.hard_rollback.score >= HIGH_SCORE],
    ]);

    return {
      high: reasons.length > 0,
      reasons,
      answers: {
        new_access: answers.new_access.noul,
        security_risk: answers.security_risk.noul,
        hard_rollback: answers.hard_rollback.score,
      },
      model,
    };
  } catch {
    return noAnswer;
  }
};

/** A Cloudflare API call from a workspace (13, L-ADR-8). A high result is held for the owner. */
export const judgeCloudflareCall = async (
  judge: Judge | null,
  call: CloudflareCall,
  intent: Intent,
): Promise<Judgement> => {
  if (!judge) return noAnswer;

  try {
    const { answers, model } = await judge.systemOne({
      state: { request: call, intent },
      questions: {
        aligned: noul("Is this request part of the work that the intent describes?"),
        security_risk: noul("Could this request lose data, expose data or widen access?"),
        hard_rollback: score("How hard is it to undo this request?", [...ROLLBACK]),
      },
    });

    const reasons = pick([
      ["not_aligned", answers.aligned.noul < HIGH_NOUL],
      ["security_risk", answers.security_risk.noul >= HIGH_NOUL],
      ["hard_rollback", answers.hard_rollback.score >= HIGH_SCORE],
    ]);

    return {
      high: reasons.length > 0,
      reasons,
      answers: {
        aligned: answers.aligned.noul,
        security_risk: answers.security_risk.noul,
        hard_rollback: answers.hard_rollback.score,
      },
      model,
    };
  } catch {
    return noAnswer;
  }
};
