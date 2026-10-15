/** 13, L-ADR-8: what a Cloudflare API request touches, and the rules that need no judge. */

export type ResourceKind = "worker" | "d1" | "kv" | "r2" | "queue";

export interface CfTarget {
  /** The account in the path, or null for paths outside an account. */
  readonly account: string | null;
  /** `worker:<name>`, `d1:<id>`, `kv:<id>`, `r2:<name>` or `queue:<id>`; null for account-wide paths. */
  readonly resource: string | null;
  /** Token, zone (DNS and routes) or deployment traffic paths, and deletes of a whole resource. */
  readonly holdList: boolean;
}

export interface ProjectResources {
  readonly accountId: string;
  /** Every resource of the project's Workers, as `kind:id`, with whether a production target uses it. */
  readonly resources: ReadonlyArray<{ readonly id: string; readonly production: boolean }>;
}

export type GateRule =
  | { readonly action: "allow" }
  | { readonly action: "hold"; readonly reasons: string[] }
  | {
      readonly action: "refuse";
      readonly body: string;
    }
  | { readonly action: "judge"; readonly resource: string };

const API_PREFIX = "/client/v4";

const RESOURCE_PATHS: ReadonlyArray<{ readonly kind: ResourceKind; readonly re: RegExp }> = [
  { kind: "worker", re: /^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)(\/.*)?$/ },
  { kind: "d1", re: /^\/accounts\/([^/]+)\/d1\/database\/([^/]+)(\/.*)?$/ },
  { kind: "kv", re: /^\/accounts\/([^/]+)\/storage\/kv\/namespaces\/([^/]+)(\/.*)?$/ },
  { kind: "r2", re: /^\/accounts\/([^/]+)\/r2\/buckets\/([^/]+)(\/.*)?$/ },
  { kind: "queue", re: /^\/accounts\/([^/]+)\/queues\/([^/]+)(\/.*)?$/ },
];

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

export const isRead = (method: string): boolean => READS.has(method.toUpperCase());

export const classifyCloudflarePath = (method: string, rawPath: string): CfTarget => {
  const path = rawPath.startsWith(API_PREFIX) ? rawPath.slice(API_PREFIX.length) : rawPath;
  const write = !isRead(method);

  for (const { kind, re } of RESOURCE_PATHS) {
    const m = re.exec(path);

    if (!m) continue;
    const rest = m[3] ?? "";
    const traffic = kind === "worker" && /^\/(deployments|routes|subdomain|domains)(\/|$)/.test(rest);

    return {
      account: decodeURIComponent(m[1]!),
      resource: `${kind}:${decodeURIComponent(m[2]!)}`,
      holdList: write && ((method.toUpperCase() === "DELETE" && rest === "") || traffic),
    };
  }

  const account = /^\/accounts\/([^/]+)/.exec(path);
  const tokens = /^\/(accounts\/[^/]+\/tokens|user\/tokens)(\/|$)/.test(path);
  const zone = /^\/zones(\/|$)/.test(path);

  return {
    account: account ? decodeURIComponent(account[1]!) : null,
    resource: null,
    holdList: write && (tokens || zone || /\/workers\/(domains|routes)(\/|$)/.test(path)),
  };
};

/** The rules before the judge: account, reads, project resources, production and the hold list. */
export const gateRule = (method: string, path: string, project: ProjectResources): GateRule => {
  const target = classifyCloudflarePath(method, path);

  if (target.account !== null && target.account !== project.accountId)
    return { action: "refuse", body: `tempo: Cloudflare account ${target.account} is not this project's` };
  const owned = project.resources.find((r) => r.id === target.resource);

  if (isRead(method))
    return target.resource === null || owned
      ? { action: "allow" }
      : { action: "hold", reasons: ["not_project"] };

  if (target.holdList) return { action: "hold", reasons: ["hold_list"] };

  if (!owned || target.resource === null) return { action: "hold", reasons: ["not_project"] };

  if (owned.production) return { action: "hold", reasons: ["production"] };

  return { action: "judge", resource: target.resource };
};
