import {
  API,
  TempoError,
  capture,
  type FnInput,
  type FnName,
  type FnOutput,
  type Result,
} from "@tempo/protocol";
import { Schema } from "effect";
import { requireOwner, type AuthedUser } from "../auth/auth.ts";
import type { Env } from "../env.ts";
import { log } from "../log.ts";
import { HANDLERS } from "./registry.ts";

export interface HandlerCtx {
  readonly env: Env;
  readonly user: AuthedUser;
}

export type Handler<K extends FnName> = (c: HandlerCtx, input: FnInput<K>) => Promise<FnOutput<K>>;

export const decodeInput = <K extends FnName>(name: K, raw: unknown): FnInput<K> => {
  const exit = Schema.decodeUnknownExit(API[name].input as unknown as Schema.Decoder<unknown>)(raw ?? {});
  if (exit._tag === "Failure") {
    throw new TempoError(
      "VALIDATION_FAILED",
      undefined,
      String(exit.cause).split("\n").slice(0, 8).join(" ").slice(0, 800),
    );
  }
  return exit.value as FnInput<K>;
};

/**
 * Runs one server function: auth middleware (owner check), schema decode, the handler.
 * Shared by the createServerFn wrappers and /api/v1/rpc (07, One handler per function).
 */
export const runFn = async <K extends FnName>(
  name: K,
  env: Env,
  headers: Headers,
  raw: unknown,
  auth: { allowCookie: boolean; allowBearer: boolean },
): Promise<Result<FnOutput<K>>> =>
  capture(async () => {
    const user = await requireOwner(env, headers, auth);
    const input = decodeInput(name, raw);
    try {
      return await (HANDLERS[name] as Handler<K>)({ env, user }, input);
    } catch (e) {
      if (!(e instanceof TempoError)) log("error", "server function failed", { fn: name, error: String(e) });
      throw e;
    }
  });
