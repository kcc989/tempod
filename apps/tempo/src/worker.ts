import startHandler from "@tanstack/react-start/server-entry";
import type { Env } from "./env.ts";
import { getAuth } from "./auth/auth.ts";
import { handleAttachment } from "./http/attachments.ts";
import { handleChannel } from "./http/channels.ts";
import { handleApiV1, handleDownload } from "./http/native.ts";
import { handlePreview, isPreviewHost } from "./http/preview.ts";
import { handleSetup, handleSetupStatus } from "./http/setup.ts";
import { log } from "./log.ts";

export { WorkspaceDO } from "./do/workspace/index.ts";
export { UserHubDO } from "./do/user-hub.ts";
export { CredentialDO } from "./do/credential.ts";
export { TempoOutbound } from "./egress/outbound.ts";
export { DirectoryBackupGateway } from "@cloudflare/sandbox";

const ATTACHMENTS = /^\/api\/workspaces\/([0-9a-hjkmnp-tv-z]{26})\/attachments$/;

export const handleRequest = async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
  const url = new URL(request.url);
  if (isPreviewHost(url.hostname, env)) return handlePreview(request, env, url);
  try {
    const path = url.pathname;
    if (path.startsWith("/api/auth/")) return (await getAuth(env)).handler(request);
    if (path.startsWith("/api/ws/"))
      return (await handleChannel(request, env, url)) ?? new Response("Not found", { status: 404 });
    if (path === "/api/setup/status") return handleSetupStatus(env);
    if (path.startsWith("/api/v1/")) return handleApiV1(request, env, url);
    const att = ATTACHMENTS.exec(path);
    if (att && request.method === "POST") return handleAttachment(request, env, att[1]!);
    if (path.startsWith("/setup/")) return handleSetup(request, env, url);
    const dl = /^\/downloads\/mac\/([^/]+)$/.exec(path);
    if (dl && request.method === "GET") return handleDownload(request, env, dl[1]!);
    void ctx;
    return await startHandler.fetch(request);
  } catch (e) {
    log("error", "request failed", { path: url.pathname, error: String(e) });
    return new Response("Something went wrong.", { status: 500 });
  }
};

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
