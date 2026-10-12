import {
  BROWSER_RUN_HOST,
  PLACEHOLDER,
  SECRET_PLACEHOLDER_PREFIX,
  SECRET_PLACEHOLDER_RE,
  hostMatches,
  type EgressPolicy,
  type Injector,
  type SecretBinding,
} from "@tempo/protocol";

export { hostMatches };

/** Built-in agent hosts for the `allowlist` policy (01). */
export const AGENT_HOSTS = [
  "api.anthropic.com",
  "claude.ai",
  "console.anthropic.com",
  "chatgpt.com",
  "auth.openai.com",
  "api.openai.com",
  "openrouter.ai",
  "registry.npmjs.org",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "cdn.playwright.dev",
  "storage.googleapis.com",
] as const;

export interface EgressConfig {
  readonly owner: string;
  readonly repo: string;
  readonly policy: EgressPolicy;
  readonly allowlist: ReadonlyArray<string>;
  /** The workspace's environment (01, Environments); absent or null means none. */
  readonly environmentId?: string | null;
  readonly secrets?: ReadonlyArray<SecretBinding>;
  readonly injectors?: ReadonlyArray<Injector>;
}

export const isRepoPath = (path: string, owner: string, repo: string): boolean => {
  const prefix = `/${owner}/${repo}`.toLowerCase();
  const p = path.toLowerCase();
  return (
    p === prefix || p === `${prefix}.git` || p.startsWith(`${prefix}/`) || p.startsWith(`${prefix}.git/`)
  );
};

const BASIC = /^basic\s+/i;

const decodeBasic = (value: string): string | null => {
  if (!BASIC.test(value)) return null;
  try {
    return atob(value.replace(BASIC, "").trim());
  } catch {
    return null;
  }
};

/** Header values to scan, plus the decoded `user:password` of `Authorization: Basic` (01, rule 13). */
const scanTexts = (url: URL, headers: Headers): string[] => {
  const out = [url.pathname, url.search];
  for (const [name, value] of headers) {
    out.push(value);
    if (name === "authorization") {
      const decoded = decodeBasic(value);
      if (decoded !== null) out.push(decoded);
    }
  }
  return out;
};

export const carriesPlaceholder = (headers: Headers, url?: URL): boolean =>
  scanTexts(url ?? new URL("https://x/"), headers).some(
    (t) => t.includes(PLACEHOLDER) || t.includes(SECRET_PLACEHOLDER_PREFIX),
  );

/** Names of every `tempo-secret-<NAME>` placeholder in the URL and headers. */
export const secretPlaceholderNames = (url: URL, headers: Headers): string[] => {
  const names = new Set<string>();
  for (const t of scanTexts(url, headers))
    for (const m of t.matchAll(SECRET_PLACEHOLDER_RE)) names.add(m[1]!);
  return [...names];
};

/** Every name is a secret of the environment bound to this host. Values are checked by the caller. */
const swappable = (host: string, names: ReadonlyArray<string>, secrets: ReadonlyArray<SecretBinding>) =>
  names.length > 0 &&
  names.every((n) => secrets.some((s) => s.name === n && s.hosts.some((p) => hostMatches(host, p))));

/** Replaces each placeholder with its value in the URL and headers. Never touches the body. */
export const swapSecrets = (
  url: URL,
  headers: Headers,
  values: Readonly<Record<string, string>>,
): { url: URL; headers: Headers } => {
  const swap = (t: string, encode: (v: string) => string = (v) => v) =>
    t.replace(SECRET_PLACEHOLDER_RE, (whole, n: string) =>
      values[n] === undefined ? whole : encode(values[n]!),
    );
  const next = new URL(url);
  next.pathname = swap(url.pathname, encodeURIComponent);
  next.search = swap(url.search, encodeURIComponent);
  const out = new Headers();
  for (const [name, value] of headers) {
    const decoded = name === "authorization" ? decodeBasic(value) : null;
    out.set(
      name,
      decoded !== null && decoded.includes(SECRET_PLACEHOLDER_PREFIX)
        ? `Basic ${btoa(swap(decoded))}`
        : swap(value),
    );
  }
  return { url: next, headers: out };
};

export type Decision =
  | { readonly rule: number; readonly action: "block"; readonly status: number; readonly body: string }
  | { readonly rule: 11; readonly action: "browser" }
  | { readonly rule: 12; readonly action: "inject"; readonly injector: Injector }
  | { readonly rule: 13; readonly action: "swap"; readonly names: ReadonlyArray<string> }
  | {
      readonly rule: number;
      readonly action: "forward";
      readonly set?: {
        readonly name: string;
        readonly value: "github-basic" | "github-bearer" | "openrouter" | "anthropic" | "openai";
      };
    };

/**
 * Rules 0 to 13 (01 and 05), first match wins; rule 11 is checked right after rule 0. Pure: credential lookup happens in the caller.
 * `set` names the credential to add; the caller fetches it and replaces the header.
 */
export const decide = (url: URL, headers: Headers, appHost: string, config: EgressConfig): Decision => {
  const host = url.hostname.toLowerCase();
  if (host === appHost.toLowerCase())
    return { rule: 0, action: "block", status: 403, body: `tempo: egress blocked for ${host}` };
  if (host === BROWSER_RUN_HOST) return { rule: 11, action: "browser" };
  if (url.protocol === "http:") return policy(8, host, config);
  if (
    (host === "github.com" || host === "codeload.github.com") &&
    isRepoPath(url.pathname, config.owner, config.repo)
  ) {
    return { rule: 2, action: "forward", set: { name: "authorization", value: "github-basic" } };
  }
  if (host === "api.github.com" || host === "uploads.github.com") {
    return { rule: 3, action: "forward", set: { name: "authorization", value: "github-bearer" } };
  }
  if (host === "openrouter.ai" && headers.get("authorization") === `Bearer ${PLACEHOLDER}`) {
    return { rule: 4, action: "forward", set: { name: "authorization", value: "openrouter" } };
  }
  if (host === "api.anthropic.com" && headers.get("x-api-key") === PLACEHOLDER) {
    return { rule: 5, action: "forward", set: { name: "x-api-key", value: "anthropic" } };
  }
  if (host === "api.openai.com" && headers.get("authorization") === `Bearer ${PLACEHOLDER}`) {
    return { rule: 6, action: "forward", set: { name: "authorization", value: "openai" } };
  }
  const injector = (config.injectors ?? []).find((i) => i.hosts.some((p) => hostMatches(host, p)));
  if (injector) return { rule: 12, action: "inject", injector };
  const names = secretPlaceholderNames(url, headers);
  if (swappable(host, names, config.secrets ?? []) && !carriesFixedPlaceholder(url, headers))
    return { rule: 13, action: "swap", names };
  if (carriesPlaceholder(headers, url)) return PLACEHOLDER_REFUSED;
  return policy(8, host, config);
};

const PLACEHOLDER_REFUSED: Decision = {
  rule: 7,
  action: "block",
  status: 403,
  body: "tempo: placeholder credential refused",
};

const carriesFixedPlaceholder = (url: URL, headers: Headers) =>
  scanTexts(url, headers).some((t) => t.includes(PLACEHOLDER));

/**
 * A subrequest from an injector (01, rule 12): rules 0 and 1, then only the injector's hosts,
 * then rule 13, then rule 7. Never rule 12 again.
 */
export const decideForInjector = (
  url: URL,
  headers: Headers,
  appHost: string,
  config: EgressConfig,
  injector: Injector,
): Decision => {
  const host = url.hostname.toLowerCase();
  const blocked = {
    rule: 12,
    action: "block",
    status: 403,
    body: `tempo: egress blocked for ${host}`,
  } as const;
  if (host === appHost.toLowerCase())
    return { rule: 0, action: "block", status: 403, body: `tempo: egress blocked for ${host}` };
  if (!injector.hosts.some((p) => hostMatches(host, p))) return blocked;
  if (url.protocol === "http:") return { rule: 12, action: "forward" };
  const names = secretPlaceholderNames(url, headers);
  if (swappable(host, names, config.secrets ?? []) && !carriesFixedPlaceholder(url, headers))
    return { rule: 13, action: "swap", names };
  if (carriesPlaceholder(headers, url)) return PLACEHOLDER_REFUSED;
  return { rule: 12, action: "forward" };
};

const policy = (_from: number, host: string, config: EgressConfig): Decision => {
  if (config.policy === "open") return { rule: 8, action: "forward" };
  if ([...AGENT_HOSTS, ...config.allowlist].some((p) => hostMatches(host, p)))
    return { rule: 9, action: "forward" };
  return { rule: 10, action: "block", status: 403, body: `tempo: egress blocked for ${host}` };
};
