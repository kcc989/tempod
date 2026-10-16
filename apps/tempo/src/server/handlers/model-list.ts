import { TempoError, modelListProblem, type FnInput, type FnOutput } from "@tempo/protocol";
import { eq } from "drizzle-orm";
import { modelLists } from "../../db/d1.ts";
import { json } from "../../db/json.ts";
import type { HandlerCtx } from "../run.ts";
import { d1 } from "./common.ts";

export const getModelList = async (c: HandlerCtx): Promise<FnOutput<"getModelList">> => {
  const row = await d1(c.env).select().from(modelLists).where(eq(modelLists.userId, c.user.id)).get();

  return row
    ? { models: json.modelPicks.read(row.modelsJson, []), updatedAt: row.updatedAt }
    : { models: [], updatedAt: null };
};

export const setModelList = async (
  c: HandlerCtx,
  { models }: FnInput<"setModelList">,
): Promise<FnOutput<"setModelList">> => {
  const problem = modelListProblem(models);

  if (problem) throw new TempoError("VALIDATION_FAILED", problem);
  const modelsJson = json.modelPicks.write(models);
  const updatedAt = Date.now();

  await d1(c.env)
    .insert(modelLists)
    .values({ userId: c.user.id, modelsJson, updatedAt })
    .onConflictDoUpdate({ target: modelLists.userId, set: { modelsJson, updatedAt } })
    .run();

  return { models, updatedAt };
};
