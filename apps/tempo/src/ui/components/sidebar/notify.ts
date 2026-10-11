import type { NotifyEvent, NotifyKind } from "~/ui/stores/hub-state";

/**
 * Settings → Notifications (04): browser notifications on or off, sound on or off. Kept per
 * browser in localStorage as `tempo:prefs:notifications`.
 */
export const NOTIFY_PREFS_KEY = "prefs:notifications";

export interface NotifyPrefs {
  readonly enabled: boolean;
  readonly sound: boolean;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { enabled: true, sound: true };

export const isNotifyPrefs = (u: unknown): u is NotifyPrefs =>
  typeof u === "object" &&
  u !== null &&
  typeof (u as NotifyPrefs).enabled === "boolean" &&
  typeof (u as NotifyPrefs).sound === "boolean";

export const NOTIFY_BODY: Record<NotifyKind, string> = {
  finished: "Finished",
  needs_input: "Waiting for you",
  error: "Needs attention",
};

export interface NotificationContent {
  readonly title: string;
  readonly body: string;
  /** One notification per workspace: a newer one replaces the older. */
  readonly tag: string;
  readonly workspaceId: string;
}

export const notificationFor = (e: NotifyEvent): NotificationContent => ({
  title: e.workspace.title,
  body: NOTIFY_BODY[e.kind],
  tag: `tempo:${e.workspace.id}`,
  workspaceId: e.workspace.id,
});

export type PermissionState = "granted" | "denied" | "default" | "unsupported";

/** 04: only while the Tempo tab is hidden, with permission granted from Settings and the setting on. */
export const shouldNotify = (ctx: {
  readonly hidden: boolean;
  readonly permission: PermissionState;
  readonly prefs: NotifyPrefs;
}): boolean => ctx.hidden && ctx.permission === "granted" && ctx.prefs.enabled;

export const notificationPermission = (): PermissionState => {
  const N = (globalThis as { Notification?: { permission: NotificationPermission } }).Notification;
  return N ? N.permission : "unsupported";
};
