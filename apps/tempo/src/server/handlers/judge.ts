import { noul } from "@typesafe-ai/sdk";
import { TempoError, type FnInput, type FnOutput } from "@tempo/protocol";
import { TYPESAFE_KEY, jevClient } from "../../judge/jev.ts";
import type { HandlerCtx } from "../run.ts";

/** The key check on save (13, L-ADR-9); tests replace `fetch`. */
export const judgeCheck = { fetch: (input: string, init?: RequestInit) => fetch(input, init) };

const creds = (c: HandlerCtx) => c.env.CREDENTIALS.getByName(c.user.id);

const settings = async (c: HandlerCtx): Promise<FnOutput<"getJudgeSettings">> => {
  const row = (await creds(c).status()).find((r) => r.key === TYPESAFE_KEY);

  return { keySet: row !== undefined, updatedAt: row?.updatedAt ?? null };
};

export const getJudgeSettings = async (c: HandlerCtx): Promise<FnOutput<"getJudgeSettings">> => settings(c);

export const setJudgeKey = async (
  c: HandlerCtx,
  { key }: FnInput<"setJudgeKey">,
): Promise<FnOutput<"setJudgeKey">> => {
  const value = key.trim();

  try {
    await jevClient(value, judgeCheck.fetch).systemOne(
      { state: "Tempo key check", questions: { ok: noul("Is this a short text?") } },
      { retry: { maxRetries: 0 } },
    );
  } catch {
    throw new TempoError("VALIDATION_FAILED", undefined, "TypeSafe AI did not accept the key.");
  }

  await creds(c).putSecret(TYPESAFE_KEY, value);

  return settings(c);
};

export const deleteJudgeKey = async (c: HandlerCtx): Promise<FnOutput<"deleteJudgeKey">> => {
  await creds(c).deleteSecret(TYPESAFE_KEY);

  return settings(c);
};
