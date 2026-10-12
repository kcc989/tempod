import { TempoError, type EgressPolicy } from "@tempo/protocol";
import { browserRunOn } from "@tempo/settings";
import { stripInternalHeaders } from "../../http/preview.ts";
import { errorText, log } from "../../log.ts";
import type { WorkspaceCore } from "./core.ts";
import { proxyToPort, validPort } from "./preview.ts";

/** Browser Run ends a session after this long without a connection (01, Browser Run). */
export const BROWSER_KEEP_ALIVE_MS = 600_000;
/** The WorkspaceDO closes a session after this long with no CDP socket open. */
export const BROWSER_IDLE_MS = 60_000;

const notFound = () => new Response("Not found", { status: 404 });
const closed = (state: string) => state === "archived" || state === "archiving";

/**
 * 01 Browser Run is on: the setting, the `open` egress policy and the `BROWSER` binding. The policy
 * is the environment's when one applies; getEgressConfig records it before rule 11 runs.
 */
export const browserRunEnabled = (core: WorkspaceCore): boolean => {
  const settings = core.settings();
  const policy = core.kv<EgressPolicy>("egressPolicy") ?? settings.environment.egress_policy;
  return (
    core.browser !== undefined &&
    browserRunOn({ ...settings, environment: { ...settings.environment, egress_policy: policy } })
  );
};

const clearBrowser = (core: WorkspaceCore): void => {
  core.setKv("browserIdleSince", undefined);
  if (core.wsOrNull()?.browserSessionId == null) return;
  core.updateWs({ browserSessionId: null });
  core.broadcastDetailSoon();
};

/** Closes the open Browser Run session: on idle, when the container stops, and on archive. */
export const closeBrowser = (core: WorkspaceCore): void => {
  const id = core.wsOrNull()?.browserSessionId ?? null;
  clearBrowser(core);
  const binding = core.browser;
  if (id === null || !binding) return;
  core.ctx.waitUntil(
    binding
      .closeSession(id)
      .then(() => undefined)
      .catch((e) =>
        log("warn", "browser run close failed", { workspaceId: core.workspaceId, error: errorText(e) }),
      ),
  );
};

const isOpen = (s: BrowserRunSession | null): s is BrowserRunSession => s !== null && s.endTime === undefined;

/** The workspace's open Browser Run session, or a new one. Null when Browser Run is off. */
export const browserSession = (core: WorkspaceCore): Promise<string | null> => {
  core.browserAcquire ??= acquire(core).finally(() => {
    core.browserAcquire = null;
  });
  return core.browserAcquire;
};

const acquire = async (core: WorkspaceCore): Promise<string | null> => {
  const binding = core.browser;
  const row = core.wsOrNull();
  if (!binding || !row || closed(row.state) || !browserRunEnabled(core)) return null;
  if (row.browserSessionId) {
    if (isOpen(await binding.getSession(row.browserSessionId))) {
      core.setKv("browserIdleSince", undefined);
      return row.browserSessionId;
    }
    clearBrowser(core);
  }
  const { sessionId } = await binding.acquire({
    keepAlive: BROWSER_KEEP_ALIVE_MS,
    outboundByHost: { localhost: core.browserOutbound() },
  });
  core.updateWs({ browserSessionId: sessionId });
  core.broadcastDetailSoon();
  core.scheduleAlarm();
  return sessionId;
};

/** TempoOutbound rule 11: the container's CDP WebSocket, joined to the session (01, Browser Run). */
export const browserConnect = async (core: WorkspaceCore, request: Request): Promise<Response> => {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return notFound();
  const id = await browserSession(core);
  if (id === null || !core.browser) return notFound();
  const connection = await core.browser.connectSession(id);
  return connection.webSocket.fetch(
    new Request(request, { headers: stripInternalHeaders(new Headers(request.headers)) }),
  );
};

/** BrowserOutbound: Browser Run's request for `localhost:<port>`, through tempod like a preview. */
export const browserFetch = (
  core: WorkspaceCore,
  request: Request,
  port: number,
  ensureAwake: () => void,
): Promise<Response> | Response => {
  const row = core.wsOrNull();
  if (!row?.browserSessionId || closed(row.state) || !validPort(port)) return notFound();
  return proxyToPort(core, request, port, ensureAwake, false);
};

/**
 * Alarm check while a session is open: forget a session Browser Run ended, and close one that has
 * had no CDP connection for BROWSER_IDLE_MS.
 */
export const browserIdleCheck = async (core: WorkspaceCore, now: number): Promise<void> => {
  const id = core.wsOrNull()?.browserSessionId ?? null;
  if (id === null) return;
  if (!core.browser || !browserRunEnabled(core)) return closeBrowser(core);
  let info: BrowserRunSession | null;
  try {
    info = await core.browser.getSession(id);
  } catch (e) {
    log("warn", "browser run check failed", { workspaceId: core.workspaceId, error: errorText(e) });
    return;
  }
  if (!isOpen(info)) return clearBrowser(core);
  const connected =
    info.connectionId !== undefined &&
    (info.connectionEndTime === undefined || (info.connectionStartTime ?? 0) > info.connectionEndTime);
  if (connected) return core.setKv("browserIdleSince", undefined);
  const since = core.kv<number>("browserIdleSince");
  if (since === undefined) return core.setKv("browserIdleSince", now);
  if (now - since >= BROWSER_IDLE_MS) closeBrowser(core);
};

/** 02 getBrowserLiveView: a fresh Live View URL for the newest page. A secret: never logged or stored. */
export const browserLiveView = async (core: WorkspaceCore): Promise<{ url: string | null }> => {
  const id = core.ws().browserSessionId;
  const binding = core.browser;
  if (!id || !binding) return { url: null };
  if (!isOpen(await binding.getSession(id))) {
    clearBrowser(core);
    return { url: null };
  }
  const page = (await binding.devtools.listTargets(id)).filter((t) => t.type === "page").at(-1);
  if (!page) throw new TempoError("INTERNAL", "The browser has no page yet.");
  const live = await binding.getLiveView(id, { targetId: page.id, mode: "tab" });
  return { url: live.devtoolsFrontendUrl };
};
