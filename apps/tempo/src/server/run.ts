import {
  API,
  TempoError,
  capture,
  type JsonData,
  type FnInput,
  type FnName,
  type FnOutput,
  type Result,
} from "@tempo/protocol";
import { Exit, Schema } from "effect";
import { getSessionUser, isOwner, type AuthedUser } from "../auth/auth.ts";
import type { Env } from "../env.ts";
import { log } from "../log.ts";
import { isVisitorFn } from "./policy.ts";
import { HANDLERS } from "./registry.ts";

/** A `visitor` function's context (11): `user` is the owner, or null for a visitor. */
export interface VisitorCtx {
  readonly env: Env;
  readonly user: AuthedUser | null;
}

export interface HandlerCtx extends VisitorCtx {
  readonly user: AuthedUser;
}

export type Handler<K extends FnName> = (c: HandlerCtx, input: FnInput<K>) => Promise<FnOutput<K>>;

export type VisitorHandler<K extends FnName> = (c: VisitorCtx, input: FnInput<K>) => Promise<FnOutput<K>>;

/** The owner, or null for a visitor (11, Function access). Other functions keep the owner check. */
const authorize = async (
  name: FnName,
  env: Env,
  headers: Headers,
  auth: { allowCookie: boolean; allowBearer: boolean },
): Promise<AuthedUser | null> => {
  const user = await getSessionUser(env, headers, auth);
  const owner = user && (await isOwner(env, user.id)) ? user : null;

  if (isVisitorFn(name)) return owner;

  if (!user) throw new TempoError("UNAUTHENTICATED");

  if (!owner) throw new TempoError("FORBIDDEN");

  return owner;
};

export const decodeInput = <K extends FnName>(
  name: K,
  raw: JsonData | FnInput<FnName> | undefined,
): FnInput<K> => {
  // SAFETY: name selects the matching input codec and FnInput<K> from the same API registry.
  const schema = API[name].input;
  const agentWrite = name === "saveAgent";
  const attachmentWrite = name === "putProjectAgent";

  const exit = Schema.decodeUnknownExit(
    schema,
    agentWrite || attachmentWrite ? { onExcessProperty: "error" } : {},
  )(raw ?? {});

  if (Exit.isFailure(exit)) {
    throw new TempoError(
      agentWrite ? "AGENT_INVALID" : attachmentWrite ? "ATTACHMENT_INVALID" : "VALIDATION_FAILED",
      undefined,
      String(exit.cause).split("\n").slice(0, 8).join(" ").slice(0, 800),
    );
  }

  return exit.value;
};

/**
 * Runs one server function: auth middleware (owner check, or the visitor policy of 11), schema
 * decode, the handler.
 * Shared by the createServerFn wrappers and /api/v1/rpc (07, One handler per function).
 */
export const runFn = async <K extends FnName>(
  name: K,
  env: Env,
  headers: Headers,
  raw: JsonData | FnInput<FnName> | undefined,
  auth: { allowCookie: boolean; allowBearer: boolean },
): Promise<Result<FnOutput<K>>> =>
  capture(async () => {
    const user = await authorize(name, env, headers, auth);
    const input = decodeInput(name, raw);

    try {
      if (isVisitorFn(name)) {
        // SAFETY: the registry maps each visitor K to VisitorHandler<K>; dispatch uses that same key.
        const handler = HANDLERS[name] as VisitorHandler<K>;

        return await handler({ env, user }, input);
      }

      if (!user) throw new TempoError("UNAUTHENTICATED");
      // SAFETY: the registry maps each K to Handler<K>; runtime dispatch uses that same key.
      const handler = HANDLERS[name] as Handler<K>;

      return await handler({ env, user }, input);
    } catch (e) {
      if (!(e instanceof TempoError)) log("error", "server function failed", { fn: name, error: String(e) });
      throw e;
    }
  });
