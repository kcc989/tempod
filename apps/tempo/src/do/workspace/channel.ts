import { CloseCode } from "@tempo/protocol";
import { asc } from "drizzle-orm";
import { sessions, turns } from "../../db/workspace-do.ts";
import type { WorkspaceCore } from "./core.ts";

const PAGE = 500;

/** Workspace channel (02): hello, then the item backlog with rev > sinceRev in pages of 500. */
export const openUiChannel = (core: WorkspaceCore, request: Request): Response => {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  const row = core.wsOrNull();
  if (!row) {
    server.accept();
    server.close(CloseCode.workspaceNotFound, "workspace not found");
    return new Response(null, { status: 101, webSocket: client });
  }
  core.ctx.acceptWebSocket(server, ["ui"]);
  const sinceRev = Math.max(0, Number(new URL(request.url).searchParams.get("sinceRev") ?? "0") || 0);
  core.sendTo(server, {
    type: "hello",
    v: 1,
    workspace: core.detail(),
    sessions: core.db
      .select()
      .from(sessions)
      .orderBy(asc(sessions.sortOrder))
      .all()
      .map((s) => core.sessionToWire(s)),
    turns: core.db
      .select()
      .from(turns)
      .orderBy(asc(turns.seq))
      .all()
      .map((t) => core.turnToWire(t)),
    itemsRev: row.itemsRev,
  });
  let after = sinceRev;
  for (;;) {
    const page = core.itemsSince(after, PAGE);
    const done = page.length < PAGE;
    core.sendTo(server, { type: "items", items: page, itemsRev: row.itemsRev, done });
    if (done) break;
    after = page[page.length - 1]!.rev;
  }
  core.scheduleAlarm();
  return new Response(null, { status: 101, webSocket: client });
};
