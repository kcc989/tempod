import { DurableObject } from "cloudflare:workers";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { CloseCode, type HubServerMessage, type WorkspaceSummary } from "@tempo/protocol";
import { json } from "../db/json.ts";
import { summaries, userHubSchema } from "../db/user-hub-do.ts";
import { USER_HUB_MIGRATIONS, runMigrations } from "../db/do-migrations.ts";
import { workspaces } from "../db/d1.ts";
import { summaryFromD1Row } from "../lib/summary.ts";
import type { Env } from "../env.ts";

const MAX_BUFFERED = 4 * 1024 * 1024;

/** Fans out sidebar updates (02, UserHubDO). One per user, named by the user id. */
export class UserHubDO extends DurableObject<Env> {
  private readonly db: DrizzleSqliteDODatabase<typeof userHubSchema>;
  private loading: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { schema: userHubSchema });
    void ctx.blockConcurrencyWhile(() => runMigrations(this.db, USER_HUB_MIGRATIONS));
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("expected websocket", { status: 426 });
    await this.loadOnce();
    // No await from here on: a publish() must not reach the socket before its hello (02, UserHubDO).
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, ["ui"]);
    this.send(server, { type: "hello", v: 1, workspaces: this.stored() });
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string" && message.includes('"ping"')) this.send(ws, { type: "pong" });
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {
      // already closed
    }
  }

  async publish(summary: WorkspaceSummary): Promise<void> {
    const prev = this.db.select().from(summaries).where(eq(summaries.workspaceId, summary.id)).get();
    if (prev && prev.rev >= summary.rev) return;
    const summaryJson = json.summary.write(summary);
    this.db
      .insert(summaries)
      .values({ workspaceId: summary.id, summaryJson, rev: summary.rev })
      .onConflictDoUpdate({ target: summaries.workspaceId, set: { summaryJson, rev: summary.rev } })
      .run();
    this.broadcast({ type: "workspace", summary });
  }

  async remove(workspaceId: string): Promise<void> {
    this.db.delete(summaries).where(eq(summaries.workspaceId, workspaceId)).run();
    this.broadcast({ type: "workspace.removed", workspaceId });
  }

  private stored(): WorkspaceSummary[] {
    return this.db
      .select()
      .from(summaries)
      .all()
      .flatMap((r) => {
        const s = json.summary.read(r.summaryJson, null);
        return s ? [s] : [];
      });
  }

  /** If the table is empty, loads it once from D1. Sockets that open meanwhile wait for the same load. */
  private loadOnce(): Promise<void> {
    if (this.loading) return this.loading;
    if (this.ctx.storage.kv.get("loadedFromD1")) return Promise.resolve();
    if (this.db.select({ id: summaries.workspaceId }).from(summaries).get()) return Promise.resolve();
    this.loading ??= this.loadFromD1().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async loadFromD1(): Promise<void> {
    const userId = this.ctx.id.name;
    if (!userId) return;
    const list = await drizzleD1(this.env.DB)
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.userId, userId), isNull(workspaces.archivedAt)))
      .orderBy(desc(workspaces.lastActivityAt))
      .all();
    for (const r of list) {
      const s = summaryFromD1Row(r);
      const summaryJson = json.summary.tryWrite(s);
      if (summaryJson === null) continue;
      // A summary published during the load is newer than D1's copy.
      this.db
        .insert(summaries)
        .values({ workspaceId: s.id, summaryJson, rev: s.rev })
        .onConflictDoNothing()
        .run();
    }
    this.ctx.storage.kv.put("loadedFromD1", true);
  }

  private broadcast(message: HubServerMessage): void {
    for (const ws of this.ctx.getWebSockets("ui")) this.send(ws, message);
  }

  private send(ws: WebSocket, message: HubServerMessage): void {
    try {
      const buffered = (ws as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0;
      if (buffered > MAX_BUFFERED) {
        ws.close(CloseCode.tooMuchBuffered, "too much buffered");
        return;
      }
      ws.send(JSON.stringify(message));
    } catch {
      // socket gone
    }
  }
}
