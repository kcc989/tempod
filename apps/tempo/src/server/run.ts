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
import { getSessionUser, requireInstanceAdmin, type AuthedUser } from "../auth/auth.ts";
import type { Env } from "../env.ts";
import { log } from "../log.ts";
import { INSTANCE_ADMIN_FNS, isPublicFn } from "./policy.ts";
import { HANDLERS, PUBLIC_HANDLERS } from "./registry.ts";

/** Context of a function that also runs without a session (11, policy `public`). */
export interface PublicCtx {
  readonly env: Env;
  readonly user: AuthedUser | null;
}

export interface HandlerCtx extends PublicCtx {
  readonly user: AuthedUser;
}

export type Handler<K extends FnName> = (c: HandlerCtx, input: FnInput<K>) => Promise<FnOutput<K>>;

export type PublicHandler<K extends FnName> = (c: PublicCtx, input: FnInput<K>) => Promise<FnOutput<K>>;

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
 * Runs one server function: auth middleware (the access policy of 11), schema decode, the handler.
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
    const user = await getSessionUser(env, headers, auth);

    if (!user && !isPublicFn(name)) throw new TempoError("UNAUTHENTICATED");

    if (user && INSTANCE_ADMIN_FNS.has(name)) await requireInstanceAdmin(env, user.id);
    const input = decodeInput(name, raw);

    try {
      if (isPublicFn(name)) {
        // SAFETY: PUBLIC_HANDLERS maps each public K to PublicHandler<K>; dispatch uses that same key.
        const handler = PUBLIC_HANDLERS[name] as PublicHandler<K>;

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
