/** The Browser tab's address bar. */

/** Only http(s) links are rendered. */
export const safeHttpUrl = (url: string): string | null => {
  try {
    const u = new URL(url);

    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
};

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * What the user typed, as an http(s) URL: a path (`/about`) stays on the current origin, a bare
 * host gets `https://`. Anything else (javascript:, data:, file:) is refused with null.
 */
export const normalizeUrl = (input: string, current: string): string | null => {
  const text = input.trim();

  if (text === "") return null;
  let candidate: string;

  if (text.startsWith("/") && !text.startsWith("//")) {
    try {
      candidate = new URL(text, current).toString();
    } catch {
      return null;
    }
  } else if (text.startsWith("//")) {
    candidate = `https:${text}`;
  } else if (SCHEME.test(text) && !/^[^/:]+:\d+(\/|$)/.test(text)) {
    candidate = text;
  } else {
    candidate = `https://${text}`;
  }

  try {
    const u = new URL(candidate);

    if (u.protocol !== "https:" && u.protocol !== "http:") return null;

    if (u.hostname === "") return null;

    return u.toString();
  } catch {
    return null;
  }
};

/**
 * The iframe sandbox. It leaves out allow-top-navigation so a preview cannot move the Tempo page
 * (IMPLEMENTATION_NOTES, Browser tab iframe).
 */
export const PREVIEW_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads";

const PREVIEW_LABEL = /^(\d{4,5})-([0-9a-hjkmnp-tv-z]{26})$/;

/** The port when `url` is a preview of this workspace (01, Preview URL), else null. */
export const previewPortOf = (url: string, workspaceId: string): number | null => {
  try {
    const m = PREVIEW_LABEL.exec(new URL(url).hostname.split(".")[0] ?? "");

    return m && m[2] === workspaceId.toLowerCase() ? Number(m[1]) : null;
  } catch {
    return null;
  }
};
