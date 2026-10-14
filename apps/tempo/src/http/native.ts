import { Option, Schema } from "effect";
import { API, FN_NAMES, type ApiMeta } from "@tempo/protocol";
import { requireUser } from "../auth/auth.ts";
import type { Env } from "../env.ts";
import { runFn } from "../server/run.ts";
import { errorOf, errorResponse } from "./common.ts";

export const MIN_MAC_CLIENT = "0.2.0";

/** /api/v1 (07, Server changes for native clients). Bearer tokens only. */
export const handleApiV1 = async (request: Request, env: Env, url: URL): Promise<Response> => {
  if (url.pathname === "/api/v1/meta" && request.method === "GET") {
    const latest = await env.DATA.get("clients/mac/latest.json");

    const release = latest
      ? Option.getOrUndefined(
          Schema.decodeUnknownOption(
            Schema.Struct({
              version: Schema.optional(Schema.Unknown),
              sha256: Schema.optional(Schema.Unknown),
            }),
          )(await latest.json()),
        )
      : undefined;

    const latestVersion =
      Schema.is(Schema.String)(release?.version) && /^\d+\.\d+\.\d+$/.test(release.version)
        ? release.version
        : null;

    const sha256 =
      Schema.is(Schema.String)(release?.sha256) && /^[a-f0-9]{64}$/.test(release.sha256)
        ? release.sha256
        : null;

    let meta: ApiMeta = {
      protocol: 1,
      serverVersion: env.TEMPO_VERSION ?? "0.1.0",
      minMacClient: MIN_MAC_CLIENT,
      latestMacClient: latestVersion,
    };

    if (latestVersion && sha256) meta = { ...meta, latestMacClientSha256: sha256 };

    return Response.json(meta);
  }

  const match = /^\/api\/v1\/rpc\/([A-Za-z]+)$/.exec(url.pathname);

  if (match && request.method === "POST") {
    const rawName = match[1];
    const name = FN_NAMES.find((candidate) => candidate === rawName);

    if (!name || !(name in API)) return errorOf("NOT_FOUND");
    let body = {} satisfies unknown;

    try {
      const text = await request.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return errorOf("VALIDATION_FAILED", "body is not JSON");
    }

    const result = await runFn(name, env, request.headers, body, { allowCookie: false, allowBearer: true });

    return result.ok ? Response.json(result.value) : errorResponse(result.error);
  }

  return errorOf("NOT_FOUND");
};

/** GET /downloads/mac/<version>: the signed DMG from R2, signed-in users only (07, 11). */
export const handleDownload = async (request: Request, env: Env, version: string): Promise<Response> => {
  try {
    await requireUser(env, request.headers);
  } catch {
    return errorOf("UNAUTHENTICATED");
  }

  if (!/^\d+\.\d+\.\d+$/.test(version)) return errorOf("NOT_FOUND");
  const obj = await env.DATA.get(`clients/mac/${version}/Tempo-${version}.dmg`);

  if (!obj) return errorOf("NOT_FOUND");

  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/x-apple-diskimage",
      "Content-Disposition": `attachment; filename="Tempo-${version}.dmg"`,
      "Content-Length": String(obj.size),
    },
  });
};
