type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A blocked health probe must never trigger Alchemy's destructive bootstrap fallback. */
export const preflightDeployment = async (
  env: Record<string, string | undefined>,
  request: Fetch,
  pendingBootstrap = false,
): Promise<boolean> => {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set.");
  const page = async (path: string) => {
    const response = await request(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Cloudflare preflight ${path} failed (${response.status}).`);
    const body = (await response.json()) as {
      success: boolean;
      result: unknown;
      result_info?: { total_pages?: number; total_count?: number; per_page?: number };
    };
    if (!body.success) throw new Error(`Cloudflare preflight ${path} failed.`);
    return body;
  };
  const api = async (path: string): Promise<unknown> => {
    const first = await page(path);
    if (!Array.isArray(first.result)) return first.result;
    const results = [...first.result];
    const info = first.result_info;
    const pages = info?.total_pages ?? Math.ceil((info?.total_count ?? 0) / (info?.per_page ?? 1));
    if (!Number.isSafeInteger(pages) || pages < 0)
      throw new Error(`Cloudflare preflight ${path} returned invalid pagination.`);
    for (let index = 2; index <= pages; index++) {
      const next = await page(`${path}?page=${index}`);
      if (!Array.isArray(next.result))
        throw new Error(`Cloudflare preflight ${path} returned invalid pagination.`);
      results.push(...next.result);
    }
    return results;
  };
  const scripts = (await api("workers/scripts")) as Array<{ id: string }>;
  if (pendingBootstrap)
    throw new Error(
      "An existing Alchemy state store has an unfinished local bootstrap. Preserve its files and verify and finish the dedicated Tempo bootstrap before resuming; do not replay generated secrets.",
    );
  if (!scripts.some((script) => script.id === "tempo-state-store")) {
    const stores = (await api("secrets_store/stores")) as Array<{ id: string }>;
    for (const store of stores) {
      const secrets = (await api(`secrets_store/stores/${store.id}/secrets`)) as Array<{ name: string }>;
      if (
        secrets.some((secret) =>
          ["TempoStateStoreToken", "TempoStateStoreEncryptionKey"].includes(secret.name),
        )
      )
        throw new Error(
          "Dedicated Tempo secrets exist without its Worker. Preserve them and recover the dedicated bootstrap; do not bootstrap or rotate secrets.",
        );
    }
    return false;
  }
  const { subdomain } = (await api("workers/subdomain")) as { subdomain?: string };
  if (!subdomain)
    throw new Error("Existing Alchemy state store has no workers.dev subdomain. Stop before bootstrap.");
  const host = `tempo-state-store.${subdomain}.workers.dev`;
  try {
    const response = await request(`https://${host}/version`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("unavailable");
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object" || !("version" in body)) throw new Error("invalid version");
    return true;
  } catch {
    throw new Error(
      `Existing Alchemy state store ${host} is unreachable. Fix network access or restore its original state; do not bootstrap or rotate secrets.`,
    );
  }
};
