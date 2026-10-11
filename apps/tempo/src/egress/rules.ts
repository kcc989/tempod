import { PLACEHOLDER, type EgressPolicy } from "@tempo/protocol";

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
}

/** `*.example.com` matches `a.example.com` but not `example.com` (05). */
export const hostMatches = (host: string, pattern: string): boolean => {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
};

export const isRepoPath = (path: string, owner: string, repo: string): boolean => {
  const prefix = `/${owner}/${repo}`.toLowerCase();
  const p = path.toLowerCase();
  return (
    p === prefix || p === `${prefix}.git` || p.startsWith(`${prefix}/`) || p.startsWith(`${prefix}.git/`)
  );
};

export const carriesPlaceholder = (headers: Headers): boolean => {
  for (const [, value] of headers) if (value.includes(PLACEHOLDER)) return true;
  return false;
};

export type Decision =
  | { readonly rule: number; readonly action: "block"; readonly status: number; readonly body: string }
  | {
      readonly rule: number;
      readonly action: "forward";
      readonly set?: {
        readonly name: string;
        readonly value: "github-basic" | "github-bearer" | "openrouter" | "anthropic" | "openai";
      };
    };

/**
 * Rules 0 to 10 (01 and 05), first match wins. Pure: credential lookup happens in the caller.
 * `set` names the credential to add; the caller fetches it and replaces the header.
 */
export const decide = (url: URL, headers: Headers, appHost: string, config: EgressConfig): Decision => {
  const host = url.hostname.toLowerCase();
  if (host === appHost.toLowerCase())
    return { rule: 0, action: "block", status: 403, body: `tempo: egress blocked for ${host}` };
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
  if (carriesPlaceholder(headers) || url.href.includes(PLACEHOLDER)) {
    return { rule: 7, action: "block", status: 403, body: "tempo: placeholder credential refused" };
  }
  return policy(8, host, config);
};

const policy = (_from: number, host: string, config: EgressConfig): Decision => {
  if (config.policy === "open") return { rule: 8, action: "forward" };
  if ([...AGENT_HOSTS, ...config.allowlist].some((p) => hostMatches(host, p)))
    return { rule: 9, action: "forward" };
  return { rule: 10, action: "block", status: 403, body: `tempo: egress blocked for ${host}` };
};
