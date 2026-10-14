import { WorkerEntrypoint } from "cloudflare:workers";
import type { Bindings } from "../env.ts";
import { BROWSER_APP_HEADER, stripInternalHeaders } from "../http/preview.ts";

export interface BrowserOutboundProps {
  readonly workspaceId: string;
}

/**
 * Browser Run's route to the app under test (01, Browser Run): `outboundByHost` sends requests
 * for `localhost` here, and the WorkspaceDO forwards them to the port through tempod.
 */
export class BrowserOutbound extends WorkerEntrypoint<Bindings, BrowserOutboundProps> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname !== "localhost" || url.port === "") return new Response("Not found", { status: 404 });
    const headers = stripInternalHeaders(new Headers(request.headers));
    headers.set(BROWSER_APP_HEADER, url.port);

    return this.ctx.exports.WorkspaceDO.getByName(this.ctx.props.workspaceId).fetch(
      new Request(request, { headers }),
    );
  }
}
