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
  const api = async (path: string): Promise<unknown> => {
    const response = await request(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Cloudflare preflight ${path} failed (${response.status}).`);
    const body = (await response.json()) as { success: boolean; result: unknown };
    if (!body.success) throw new Error(`Cloudflare preflight ${path} failed.`);
    return body.result;
  };
  const scripts = (await api("workers/scripts")) as Array<{ id: string }>;
  if (!scripts.some((script) => script.id === "tempo-state-store")) return false;
  if (pendingBootstrap)
    throw new Error(
      "An existing Alchemy state store has an unfinished local bootstrap. Preserve its files and verify and finish the dedicated Tempo bootstrap before resuming; do not replay generated secrets.",
    );
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
