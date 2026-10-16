import { Option, Schema } from "effect";
import type { DeployPermission } from "@tempo/protocol";
import { PERMISSION_GROUPS } from "./types.ts";

/** The Cloudflare API calls of 12 (Owner settings and Tokens). `fetch` is replaceable for tests. */
export interface CloudflareApi {
  fetch: (request: Request) => Promise<Response>;
}

const API = "https://api.cloudflare.com/client/v4";

const Group = Schema.Struct({ id: Schema.String, name: Schema.String, scopes: Schema.Array(Schema.String) });

const Created = Schema.Struct({ id: Schema.String, value: Schema.String });

const Envelope = Schema.Struct({ success: Schema.Literal(true), result: Schema.Json });

export class CloudflareError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const call = async (
  api: CloudflareApi,
  token: string,
  request: { method: string; path: string; body?: Schema.Json },
): Promise<Schema.Json> => {
  const init: RequestInit = { method: request.method, headers: { authorization: `Bearer ${token}` } };

  if (request.body !== undefined) {
    init.headers = { ...init.headers, "content-type": "application/json" };
    init.body = JSON.stringify(request.body);
  }

  const res = await api.fetch(new Request(`${API}${request.path}`, init));
  const parsed = Schema.decodeUnknownOption(Envelope)(await res.json().catch(() => null));

  if (!res.ok || Option.isNone(parsed))
    throw new CloudflareError(res.status, `Cloudflare answered ${res.status}`);

  return parsed.value.result;
};

/** The token check on save, and the group catalog at mint time. */
export const permissionGroups = async (api: CloudflareApi, token: string, accountId: string) =>
  Schema.decodeUnknownSync(Schema.Array(Group))(
    await call(api, token, { method: "GET", path: `/accounts/${accountId}/tokens/permission_groups` }),
  );

const SCOPES = { account: "com.cloudflare.api.account", zone: "com.cloudflare.api.account.zone" } as const;

/** Builds the policies of 12, Tokens. Throws with the summary text when a group is missing. */
export const tokenPolicies = (
  groups: ReadonlyArray<typeof Group.Type>,
  permissions: ReadonlyArray<DeployPermission>,
  accountId: string,
) => {
  const account = `com.cloudflare.api.account.${accountId}`;
  const policies: Schema.JsonObject[] = [];

  for (const scope of ["account", "zone"] as const) {
    const names = permissions.flatMap((p) =>
      PERMISSION_GROUPS[p].scope === scope ? PERMISSION_GROUPS[p].groups : [],
    );

    if (names.length === 0) continue;

    const ids = [...new Set(names)].map((name) => {
      const group = groups.find((g) => g.name === name && g.scopes.includes(SCOPES[scope]));

      if (!group) throw new Error(`Cloudflare has no permission group "${name}".`);

      return { id: group.id };
    });

    policies.push({
      effect: "allow",
      resources:
        scope === "account"
          ? { [account]: "*" }
          : { [account]: { "com.cloudflare.api.account.zone.*": "*" } },
      permission_groups: ids,
    });
  }

  return policies;
};

export const createToken = async (
  api: CloudflareApi,
  master: string,
  accountId: string,
  input: { name: string; expiresAt: number; policies: Schema.Json },
) =>
  Schema.decodeUnknownSync(Created)(
    await call(api, master, {
      method: "POST",
      path: `/accounts/${accountId}/tokens`,
      body: {
        name: input.name,
        expires_on: new Date(Math.floor(input.expiresAt / 1000) * 1000).toISOString().replace(".000Z", "Z"),
        policies: input.policies,
      },
    }),
  );

/** True when the token is gone (2xx or 404). */
export const deleteToken = async (
  api: CloudflareApi,
  master: string,
  accountId: string,
  tokenId: string,
): Promise<boolean> => {
  try {
    await call(api, master, { method: "DELETE", path: `/accounts/${accountId}/tokens/${tokenId}` });

    return true;
  } catch (e) {
    if (e instanceof CloudflareError && e.status === 404) return true;

    return false;
  }
};

const DeploymentVersion = Schema.Struct({ version_id: Schema.String, percentage: Schema.Number });

const WorkerDeployment = Schema.Struct({
  id: Schema.String,
  created_on: Schema.String,
  versions: Schema.Array(DeploymentVersion),
});

export type WorkerDeployment = typeof WorkerDeployment.Type;

export interface TrafficSplit {
  readonly versionId: string;
  readonly percentage: number;
}

const script = (accountId: string, name: string) =>
  `/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}`;

/** The Worker's deployments, newest first. The first one is live (13, L-ADR-4). */
export const listWorkerDeployments = async (
  api: CloudflareApi,
  token: string,
  accountId: string,
  name: string,
): Promise<ReadonlyArray<WorkerDeployment>> =>
  Schema.decodeUnknownSync(Schema.Struct({ deployments: Schema.Array(WorkerDeployment) }))(
    await call(api, token, { method: "GET", path: `${script(accountId, name)}/deployments` }),
  ).deployments;

/**
 * Moves traffic: one version at 100% (a rollback or a full step), or two versions that add up
 * to 100 (a gradual step). Cloudflare refuses any other split.
 */
export const createWorkerDeployment = async (
  api: CloudflareApi,
  token: string,
  accountId: string,
  name: string,
  input: { split: ReadonlyArray<TrafficSplit>; message: string },
): Promise<WorkerDeployment> => {
  const total = input.split.reduce((sum, s) => sum + s.percentage, 0);

  if (input.split.length < 1 || input.split.length > 2 || total !== 100)
    throw new Error("A deployment needs one or two versions that add up to 100%.");

  return Schema.decodeUnknownSync(WorkerDeployment)(
    await call(api, token, {
      method: "POST",
      path: `${script(accountId, name)}/deployments`,
      body: {
        strategy: "percentage",
        versions: input.split.map((s) => ({ version_id: s.versionId, percentage: s.percentage })),
        annotations: { "workers/message": input.message.slice(0, 1000) },
      },
    }),
  );
};

const WorkerVersion = Schema.Struct({
  id: Schema.String,
  metadata: Schema.Struct({ created_on: Schema.String }),
});

/** The Worker's newest uploaded versions, newest first. */
export const listWorkerVersions = async (
  api: CloudflareApi,
  token: string,
  accountId: string,
  name: string,
): Promise<ReadonlyArray<{ id: string; createdOn: string }>> =>
  Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(WorkerVersion) }))(
    await call(api, token, { method: "GET", path: `${script(accountId, name)}/versions?per_page=20` }),
  )
    .items.map((v) => ({ id: v.id, createdOn: v.metadata.created_on }))
    .toSorted((a, b) => Date.parse(b.createdOn) - Date.parse(a.createdOn));

const Binding = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  namespace_id: Schema.optional(Schema.String),
  bucket_name: Schema.optional(Schema.String),
  queue_name: Schema.optional(Schema.String),
});

const BINDING_IDS = new Map<string, (b: typeof Binding.Type) => string | undefined>([
  ["d1", (b) => (b.id ? `d1:${b.id}` : undefined)],
  ["kv_namespace", (b) => (b.namespace_id ? `kv:${b.namespace_id}` : undefined)],
  ["r2_bucket", (b) => (b.bucket_name ? `r2:${b.bucket_name}` : undefined)],
  ["queue", (b) => (b.queue_name ? `queue:${b.queue_name}` : undefined)],
]);

/** 13, L-ADR-8: the databases, namespaces, buckets and queues a Worker binds, as `kind:id`. Empty when the Worker is missing. */
export const workerResources = async (
  api: CloudflareApi,
  token: string,
  accountId: string,
  worker: string,
): Promise<string[]> => {
  try {
    const result = Schema.decodeUnknownSync(Schema.Struct({ bindings: Schema.Array(Binding) }))(
      await call(api, token, {
        method: "GET",
        path: `/accounts/${accountId}/workers/scripts/${encodeURIComponent(worker)}/settings`,
      }),
    );

    return result.bindings.flatMap((b) => BINDING_IDS.get(b.type)?.(b) ?? []);
  } catch (e) {
    if (e instanceof CloudflareError && e.status === 404) return [];
    throw e;
  }
};
