import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTIFY_PREFS,
  isNotifyPrefs,
  notificationFor,
  notificationPermission,
  shouldNotify,
} from "~/ui/components/sidebar/notify";
import { HubStore } from "~/ui/stores/hub-store";
import type { NotifyEvent } from "~/ui/stores/hub-state";
import { summary } from "../fixtures";

describe("browser notification content (04)", () => {
  it("uses the workspace title and the 04 body per event", () => {
    const w = summary({ id: "w9", title: "Lisbon" });
    expect(notificationFor({ kind: "finished", workspace: w })).toEqual({
      title: "Lisbon",
      body: "Finished",
      tag: "tempo:w9",
      workspaceId: "w9",
    });
    expect(notificationFor({ kind: "needs_input", workspace: w }).body).toBe("Waiting for you");
    expect(notificationFor({ kind: "error", workspace: w }).body).toBe("Needs attention");
  });

  it("notifies only while hidden, with permission and the setting on", () => {
    const on = DEFAULT_NOTIFY_PREFS;
    expect(shouldNotify({ hidden: true, permission: "granted", prefs: on })).toBe(true);
    expect(shouldNotify({ hidden: false, permission: "granted", prefs: on })).toBe(false);
    expect(shouldNotify({ hidden: true, permission: "default", prefs: on })).toBe(false);
    expect(shouldNotify({ hidden: true, permission: "denied", prefs: on })).toBe(false);
    expect(shouldNotify({ hidden: true, permission: "unsupported", prefs: on })).toBe(false);
    expect(
      shouldNotify({ hidden: true, permission: "granted", prefs: { enabled: false, sound: true } }),
    ).toBe(false);
  });

  it("guards the stored preference", () => {
    expect(isNotifyPrefs({ enabled: true, sound: false })).toBe(true);
    expect(isNotifyPrefs({ enabled: "yes", sound: false })).toBe(false);
    expect(isNotifyPrefs(null)).toBe(false);
  });
});

describe("notificationPermission", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the Notification API, or says it is missing", () => {
    vi.stubGlobal("Notification", undefined);
    expect(notificationPermission()).toBe("unsupported");
    vi.stubGlobal("Notification", { permission: "granted" });
    expect(notificationPermission()).toBe("granted");
  });
});

describe("hub events to notifications", () => {
  it("turns hub transitions into the three 04 notifications", () => {
    const hub = new HubStore();
    const seen: NotifyEvent[] = [];
    hub.onNotify((e) => seen.push(e));
    const hello = (ws: ReturnType<typeof summary>[]) =>
      JSON.stringify({ type: "hello", v: 1, workspaces: ws });
    const update = (w: ReturnType<typeof summary>) => JSON.stringify({ type: "workspace", summary: w });
    hub.receive(hello([summary({ id: "a", state: "working" }), summary({ id: "b" }), summary({ id: "c" })]));
    hub.receive(update(summary({ id: "a", state: "ready", rev: 2 })));
    hub.receive(update(summary({ id: "b", attention: "needs_input", rev: 2 })));
    hub.receive(update(summary({ id: "c", state: "error", attention: "error", rev: 2 })));
    expect(seen.map((e) => notificationFor(e).body)).toEqual([
      "Finished",
      "Waiting for you",
      "Needs attention",
    ]);
  });
});
