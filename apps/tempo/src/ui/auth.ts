import { queryOptions } from "@tanstack/react-query";
import { ERROR_MESSAGES } from "@tempo/protocol";
import { createAuthClient } from "better-auth/client";
import { deviceAuthorizationClient } from "better-auth/client/plugins";

/** Better Auth in the browser (05, Authentication). Mounted by the Worker at /api/auth. */
const makeClient = () => createAuthClient({ basePath: "/api/auth", plugins: [deviceAuthorizationClient()] });

let client: ReturnType<typeof makeClient> | null = null;

export const authClient = (): ReturnType<typeof makeClient> => {
  client ??= makeClient();
  return client;
};

export interface AuthUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
}

export interface AuthSession {
  readonly user: AuthUser;
  readonly sessionId: string;
}

interface FetchError {
  readonly status?: number;
  readonly message?: string;
  readonly error?: string;
  readonly code?: string;
}

const fetchSession = async (): Promise<AuthSession | null> => {
  const { data, error } = await authClient().getSession();
  if (error) {
    if ((error as FetchError).status === 401) return null;
    throw new Error((error as FetchError).message ?? "Session check failed");
  }
  if (!data) return null;
  const u = data.user;
  return {
    user: { id: u.id, name: u.name, email: u.email, image: u.image ?? null },
    sessionId: data.session.id,
  };
};

export const sessionQueryOptions = queryOptions({
  queryKey: ["auth", "session"] as const,
  queryFn: fetchSession,
  staleTime: 5 * 60_000,
  retry: 1,
});

/** Only same-site paths are followed after sign-in. */
export const safeRedirect = (path: unknown): string =>
  typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\")
    ? path
    : "/";

/** 05: a sign-in refused by the owner check comes back to /login as ?error=forbidden. */
export const loginErrorText = (error: string | undefined): string | null => {
  if (!error) return null;
  return error.toLowerCase() === "forbidden" ? ERROR_MESSAGES.FORBIDDEN : ERROR_MESSAGES.INTERNAL;
};

export const signInWithGithub = async (redirect?: string): Promise<void> => {
  const { error } = await authClient().signIn.social({
    provider: "github",
    callbackURL: safeRedirect(redirect),
    errorCallbackURL: "/login",
  });
  if (error) throw new Error((error as FetchError).message ?? "Sign-in failed");
};

/** Signs out and reloads at /login, which drops every socket and cached query. */
export const signOut = async (): Promise<void> => {
  try {
    await authClient().signOut();
  } finally {
    globalThis.location?.assign("/login");
  }
};

// Settings → Devices (07): sign-in sessions with Revoke.

export interface DeviceSession {
  readonly id: string;
  readonly token: string;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly current: boolean;
}

const ms = (d: unknown): number =>
  d instanceof Date
    ? d.getTime()
    : typeof d === "string" || typeof d === "number"
      ? new Date(d).getTime()
      : 0;

export const listDeviceSessions = async (currentSessionId?: string): Promise<DeviceSession[]> => {
  const { data, error } = await authClient().listSessions();
  if (error) throw new Error((error as FetchError).message ?? "Could not list sessions");
  return (data ?? [])
    .map((s) => ({
      id: s.id,
      token: s.token,
      userAgent: s.userAgent ?? null,
      ipAddress: s.ipAddress ?? null,
      createdAt: ms(s.createdAt),
      updatedAt: ms(s.updatedAt),
      expiresAt: ms(s.expiresAt),
      current: s.id === currentSessionId,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
};

export const revokeDeviceSession = async (token: string): Promise<void> => {
  const { error } = await authClient().revokeSession({ token });
  if (error) throw new Error((error as FetchError).message ?? "Could not revoke the session");
};

/** A short name for a session's user agent. */
export const sessionLabel = (userAgent: string | null): string => {
  if (!userAgent) return "Unknown device";
  if (/tempo/i.test(userAgent) && /mac|darwin/i.test(userAgent)) return "Tempo for Mac";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser";
  const os = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Mac OS X|Macintosh/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  return os ? `${browser} on ${os}` : browser;
};

// Device sign-in (07, Sign-in and first run). The GET claims the code for this user; it must come
// before approve or deny.

export type DeviceCodeStatus = "pending" | "approved" | "denied";

export type DeviceLookup =
  | { readonly ok: true; readonly status: DeviceCodeStatus; readonly clientId: string | null }
  | { readonly ok: false; readonly reason: "invalid" | "expired" | "processed" | "error" };

const failure = (error: unknown): DeviceLookup => {
  const e = error as FetchError;
  const code = e.error ?? e.code ?? "";
  if (/expired/i.test(code)) return { ok: false, reason: "expired" };
  if (/already_processed|ALREADY_PROCESSED/i.test(code) || /already processed/i.test(e.message ?? "")) {
    return { ok: false, reason: "processed" };
  }
  if (e.status === 400) return { ok: false, reason: "invalid" };
  return { ok: false, reason: "error" };
};

export const normalizeUserCode = (code: string): string => code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

/** XXXX-XXXX for display, as Tempo for Mac shows it. */
export const formatUserCode = (code: string): string => {
  const n = normalizeUserCode(code);
  return n.length === 8 ? `${n.slice(0, 4)}-${n.slice(4)}` : n;
};

export const claimDeviceCode = async (userCode: string): Promise<DeviceLookup> => {
  const { data, error } = await authClient().$fetch<{ status: DeviceCodeStatus; client_id?: string }>(
    "/device",
    {
      method: "GET",
      query: { user_code: userCode },
    },
  );
  if (error || !data) return failure(error);
  return { ok: true, status: data.status, clientId: data.client_id ?? null };
};

const decide = async (path: "/device/approve" | "/device/deny", userCode: string): Promise<DeviceLookup> => {
  const { error } = await authClient().$fetch(path, { method: "POST", body: { userCode } });
  if (error) return failure(error);
  return { ok: true, status: path === "/device/approve" ? "approved" : "denied", clientId: null };
};

/** The /device page's text for each outcome. */
export const deviceOutcomeText = (r: DeviceLookup): string => {
  if (r.ok) {
    if (r.status === "approved") return "Tempo for Mac is signed in. You can close this tab.";
    if (r.status === "denied") return "Sign-in denied. You can close this tab.";
    return "";
  }
  switch (r.reason) {
    case "invalid":
      return "That code is not valid. Check it and try again.";
    case "expired":
      return "That code has expired. Start again in Tempo for Mac.";
    case "processed":
      return "This code was already used.";
    case "error":
      return ERROR_MESSAGES.INTERNAL;
  }
};

export const approveDevice = (userCode: string): Promise<DeviceLookup> => decide("/device/approve", userCode);

export const denyDevice = (userCode: string): Promise<DeviceLookup> => decide("/device/deny", userCode);

/** GET /api/setup/status (no auth): whether the GitHub App exists, and its install link. */
export interface SetupStatus {
  readonly configured: boolean;
  readonly installUrl: string | null;
}

export const setupStatusQueryOptions = queryOptions({
  queryKey: ["setup", "status"] as const,
  queryFn: async (): Promise<SetupStatus> => {
    const res = await fetch("/api/setup/status", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Setup status returned ${res.status}`);
    const body = (await res.json()) as { configured?: unknown; installUrl?: unknown };
    return {
      configured: body.configured === true,
      installUrl: typeof body.installUrl === "string" && body.installUrl !== "" ? body.installUrl : null,
    };
  },
  staleTime: 60_000,
});
