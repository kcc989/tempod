import type { ApiKeyProvider, CredentialProvider, CredentialStatus } from "@tempo/protocol";
import { formatRelative } from "~/ui/lib/format";

/**
 * Settings → Logins (04; 02, Credentials). Values are write-only: the UI shows set or not set and
 * when, never the value. Checks here run before a save and never echo the value back.
 */

export interface LoginRow {
  readonly provider: CredentialProvider;
  readonly label: string;
  /** The CredentialDO key (02); deleteCredential takes it. */
  readonly key: string;
  readonly kind: "claudeToken" | "codexAuth" | "apiKey";
}

export const LOGIN_ROWS: ReadonlyArray<LoginRow> = [
  { provider: "claude", label: "Claude", key: "claude.oauth_token", kind: "claudeToken" },
  { provider: "codex", label: "Codex", key: "codex.auth_json", kind: "codexAuth" },
  { provider: "openrouter", label: "OpenRouter key", key: "openrouter.api_key", kind: "apiKey" },
  { provider: "anthropic", label: "Anthropic key", key: "anthropic.api_key", kind: "apiKey" },
  { provider: "openai", label: "OpenAI key", key: "openai.api_key", kind: "apiKey" },
];

export const isApiKeyProvider = (p: CredentialProvider): p is ApiKeyProvider =>
  p === "openrouter" || p === "anthropic" || p === "openai";

/** setClaudeToken: no spaces, 20 to 4096 characters (02). */
export const checkClaudeToken = (token: string): string | null => {
  const t = token.trim();
  if (t === "") return "Paste the token first.";
  if (/\s/.test(t)) return "A token has no spaces. Paste it again.";
  if (t.length < 20 || t.length > 4096) return "That does not look like a token from claude setup-token.";
  return null;
};

/** setCodexAuth: must parse and hold tokens.access_token, tokens.refresh_token and last_refresh (02). */
export const checkCodexAuth = (text: string): string | null => {
  if (text.trim() === "") return "Upload or paste auth.json first.";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "That is not JSON. Use the auth.json that codex login writes.";
  }
  const o = parsed as {
    tokens?: { access_token?: unknown; refresh_token?: unknown };
    last_refresh?: unknown;
  };
  if (
    typeof o?.tokens?.access_token !== "string" ||
    typeof o.tokens.refresh_token !== "string" ||
    typeof o.last_refresh !== "string" ||
    Number.isNaN(Date.parse(o.last_refresh))
  ) {
    return "That auth.json has no tokens. Run codex login and try again.";
  }
  return null;
};

export const checkApiKey = (key: string): string | null => {
  const k = key.trim();
  if (k === "") return "Paste the key first.";
  if (/\s/.test(k)) return "A key has no spaces. Paste it again.";
  return null;
};

/** auth.json is small; a bigger file is the wrong file. */
export const MAX_AUTH_JSON_BYTES = 256 * 1024;

export interface LoginState {
  readonly set: boolean;
  /** `Updated 5 min ago`, when known. */
  readonly updated: string | null;
}

export const loginState = (
  status: CredentialStatus | undefined,
  provider: CredentialProvider,
  now: number = Date.now(),
): LoginState => {
  const s = status?.[provider];
  if (!s?.set) return { set: false, updated: null };
  return { set: true, updated: s.updatedAt ? `Updated ${formatRelative(s.updatedAt, now)}` : null };
};
