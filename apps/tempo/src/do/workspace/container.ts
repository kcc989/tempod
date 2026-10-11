import { DirectoryBackup } from "@cloudflare/sandbox";
import { and, desc, eq } from "drizzle-orm";
import {
  HealthResponse,
  TempoError,
  instanceLabel,
  randomToken,
  type DoHello,
  type Instance,
  type TempodEvent,
  type TempodEventEnvelope,
} from "@tempo/protocol";
import { Schema } from "effect";
import { snapshots, type SnapshotRow } from "../../db/workspace-do.ts";
import { errorText, log } from "../../log.ts";
import type { WorkspaceCore } from "./core.ts";
import { TempodClient, openTempodSocket, tempodFetch } from "./tempod-client.ts";
import { CONTAINER_STATES } from "./transitions.ts";

export const SNAPSHOT_MAX_AGE_MS = 29 * 24 * 60 * 60_000;
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 250;
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16_000];
const SAFETY_MARGIN_MS = 15 * 60_000;
const MAX_INACTIVITY_MS = 21_600_000;

const decodeHealth = Schema.decodeUnknownOption(HealthResponse);

export const homeBackup = (core: WorkspaceCore): DirectoryBackup =>
  new DirectoryBackup(core.container!, core.ctx.exports.DirectoryBackupGateway, {
    binding: "DATA",
    prefix: `homes/${core.workspaceId}/`,
  });

export const containerRunning = (core: WorkspaceCore): boolean => core.container?.running ?? false;

/** A snapshot is usable if it came from the current image and is younger than 29 days (01). */
export const usableSnapshot = (core: WorkspaceCore): SnapshotRow | null => {
  const image = core.container?.images["workspace"] ?? null;
  if (!image) return null;
  const now = Date.now();
  const rows = core.db
    .select()
    .from(snapshots)
    .where(and(eq(snapshots.unusable, 0), eq(snapshots.imageRef, image)))
    .orderBy(desc(snapshots.createdAt))
    .all();
  return rows.find((s) => now - Math.max(s.createdAt, s.lastRestoredAt ?? 0) < SNAPSHOT_MAX_AGE_MS) ?? null;
};

const instanceOf = (core: WorkspaceCore): Instance => core.settings().environment.instance;

/**
 * Starts the container (01, Start procedure). The env holds no credentials. Intercepts are
 * registered after every start: the backup gateway first, then the catch-all egress handler.
 */
export const startContainer = async (core: WorkspaceCore, snapshot: SnapshotRow | null): Promise<void> => {
  const container = core.container;
  if (!container) throw new TempoError("CONTAINER_START_FAILED", undefined, "no container binding");
  const row = core.ws();
  const token = randomToken(32);
  core.updateWs({ tempodToken: token });
  const props = { workspaceId: row.workspaceId, userId: row.userId };
  const sleepAfterMs = core.settings().environment.sleep_after_idle_minutes * 60_000;
  container.start({
    ...(snapshot ? { containerSnapshot: { id: snapshot.id } } : { image: container.images["workspace"] ?? "workspace" }),
    instance: instanceOf(core),
    enableInternet: false,
    env: { TEMPOD_TOKEN: token, TEMPOD_PORT: "7070", TEMPO_WORKSPACE_ID: row.workspaceId },
    labels: { workspace: row.workspaceId },
  });
  await homeBackup(core).intercept();
  const outbound = core.ctx.exports.TempoOutbound({ props });
  await container.interceptAllOutboundHttp(outbound);
  await container.interceptOutboundHttps("*", outbound);
  await container.setInactivityTimeout(Math.min(sleepAfterMs + SAFETY_MARGIN_MS, MAX_INACTIVITY_MS));
  core.updateWs({ imageRef: container.images["workspace"] ?? null });
  core.liveSessions.clear();
  log("info", "container started", {
    workspaceId: row.workspaceId,
    fromSnapshot: snapshot !== null,
    instance: instanceLabel(instanceOf(core)),
  });
};

/** Readiness = GET /v1/health returns 200. Polls every 250 ms for at most 60 s. */
export const waitHealthy = async (core: WorkspaceCore, signal: AbortSignal): Promise<{ version: string; incarnation: string }> => {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    if (signal.aborted) break;
    if (!containerRunning(core) && Date.now() > deadline - HEALTH_TIMEOUT_MS + 5000) last = "container is not running";
    try {
      const res = await tempodFetch(core, "/v1/health");
      if (res.status === 200) {
        const body = decodeHealth(await res.json());
        if (body._tag === "Some") {
          core.tempodVersion = body.value.version;
          return { version: body.value.version, incarnation: body.value.incarnation };
        }
      }
      last = `health returned ${res.status}`;
    } catch (e) {
      last = errorText(e);
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  throw new TempoError("CONTAINER_START_FAILED", undefined, `tempod never became healthy: ${last}`);
};

export const destroyContainer = async (core: WorkspaceCore, reason: string): Promise<void> => {
  core.closingTempod = true;
  core.tempod?.close(1000, reason);
  core.tempod = null;
  core.closeTerminals(1001, "container stopped");
  if (containerRunning(core)) await core.container!.destroy();
  core.updateWs({ tempodToken: null });
  core.liveSessions.clear();
  core.closingTempod = false;
};

export interface ConnectHandlers {
  readonly onEvent: (event: TempodEvent, envelope: TempodEventEnvelope) => Promise<void> | void;
  readonly onLost: () => void;
}

/** Opens the tempod WebSocket and sends `hello` with the stored incarnation and acked seq (03, Wake). */
export const connectTempod = async (core: WorkspaceCore, handlers: ConnectHandlers): Promise<TempodClient> => {
  if (core.tempod?.open) return core.tempod;
  const socket = await openTempodSocket(core);
  const client = new TempodClient(core, socket, handlers.onEvent, (c, code) => {
    if (core.tempod === c) core.tempod = null;
    if (!core.closingTempod && code !== 4001) handlers.onLost();
  });
  const project = await core.project();
  const row = core.ws();
  const hello: DoHello = {
    type: "hello",
    v: 1,
    incarnation: row.tempodIncarnation,
    lastAckedSeq: row.tempodAckedSeq,
    workspace: {
      id: row.workspaceId,
      slug: row.slug,
      branch: row.branch,
      baseBranch: row.baseBranch,
      repo: { owner: project.owner, name: project.name },
    },
    env: await core.scriptEnv(),
  };
  client.sendHello(hello);
  core.tempod = client;
  core.reconnectAttempt = 0;
  return client;
};

/**
 * The tempod socket closed while the container runs: reconnect up to 5 times (1, 2, 4, 8, 16 s),
 * then destroy and wake (03, Failure handling).
 */
export const scheduleReconnect = (
  core: WorkspaceCore,
  handlers: ConnectHandlers,
  giveUp: () => Promise<void>,
): void => {
  if (core.reconnectTimer) return;
  const attempt = core.reconnectAttempt;
  if (attempt >= RECONNECT_DELAYS.length) {
    core.reconnectAttempt = 0;
    void giveUp();
    return;
  }
  core.reconnectTimer = setTimeout(async () => {
    core.reconnectTimer = null;
    const state = core.wsOrNull()?.state;
    if (!state || !(CONTAINER_STATES as ReadonlyArray<string>).includes(state) || !containerRunning(core)) return;
    core.reconnectAttempt = attempt + 1;
    try {
      await connectTempod(core, handlers);
      log("info", "tempod reconnected", { workspaceId: core.workspaceId, attempt: attempt + 1 });
    } catch (e) {
      log("warn", "tempod reconnect failed", { workspaceId: core.workspaceId, attempt: attempt + 1, error: errorText(e) });
      scheduleReconnect(core, handlers, giveUp);
    }
  }, RECONNECT_DELAYS[attempt]);
};

export const requireTempod = (core: WorkspaceCore): TempodClient => {
  if (!core.tempod?.open || !containerRunning(core)) throw new TempoError("CONTAINER_NOT_READY");
  return core.tempod;
};
