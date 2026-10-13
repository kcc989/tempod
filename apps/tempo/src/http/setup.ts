import type { AppSetupStatus } from "@tempo/protocol";
import { SYSTEM_CREDENTIALS } from "../do/credential.ts";
import type { Env } from "../env.ts";
import { clearGithubAppConfigCache, getGithubAppConfig } from "../github/app.ts";
import { timingSafeEqual } from "../lib/crypto.ts";
import { errorText, log } from "../log.ts";
import { getSessionUser, isOwner } from "../auth/auth.ts";
import { listInstallations } from "../server/handlers/projects.ts";
import { appOrigin, escapeHtml, html } from "./common.ts";

const notFound = () => new Response("Not found", { status: 404 });

/** 05, GitHub App setup (manifest flow). Works only while no App is configured, and only with the token. */
export const handleSetup = async (request: Request, env: Env, url: URL): Promise<Response> => {
  if (url.pathname === "/setup/github/installed") {
    // GitHub's setup_url (05 step 5). A signed-in owner gets the new installation stored now;
    // otherwise the Add project dialog syncs GET /app/installations after sign-in.
    await storeInstallation(request, env, url.searchParams.get("installation_id"));
    return Response.redirect(`${appOrigin(env)}/`, 302);
  }
  if (await getGithubAppConfig(env, { fresh: true })) return notFound();
  const token = url.searchParams.get("token") ?? url.searchParams.get("state") ?? "";
  if (!env.TEMPO_SETUP_TOKEN || !timingSafeEqual(token, env.TEMPO_SETUP_TOKEN)) return notFound();

  if (url.pathname === "/setup/github" && request.method === "GET") return setupPage(env, token);
  if (url.pathname === "/setup/github/callback" && request.method === "GET") {
    const code = url.searchParams.get("code");
    if (!code) return html("<h1>Missing code</h1>", 400);
    const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "tempo",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      log("warn", "github manifest conversion failed", { status: res.status });
      return html(`<h1>GitHub returned ${res.status}</h1><p>Start again from the setup link.</p>`, 502);
    }
    const app = (await res.json()) as {
      id: number;
      slug: string;
      pem: string;
      client_id: string;
      client_secret: string;
    };
    await env.CREDENTIALS.getByName(SYSTEM_CREDENTIALS).putGithubAppConfig({
      appId: String(app.id),
      slug: app.slug,
      privateKey: app.pem,
      clientId: app.client_id,
      clientSecret: app.client_secret,
    });
    clearGithubAppConfigCache();
    const install = `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`;
    return html(
      `<h1>GitHub App created</h1><p>Next, install <code>${escapeHtml(app.slug)}</code> on your account or organization.</p><p><a href="${install}">Install the GitHub App</a></p><p>Then <a href="/">sign in to Tempo</a>.</p>`,
    );
  }
  return notFound();
};

const storeInstallation = async (
  request: Request,
  env: Env,
  installationId: string | null,
): Promise<void> => {
  if (!installationId || !/^[1-9][0-9]{0,15}$/.test(installationId)) return;
  try {
    const user = await getSessionUser(env, request.headers, { allowCookie: true, allowBearer: false });
    if (!user || !(await isOwner(env, user.id))) return;
    const stored = await listInstallations({ env, user });
    if (!stored.some((i) => i.installationId === Number(installationId)))
      log("warn", "installation from setup_url not found", { installationId: Number(installationId) });
  } catch (e) {
    log("warn", "installation sync failed", { error: errorText(e) });
  }
};

export const manifest = (env: Env) => {
  const origin = appOrigin(env);
  return {
    name: `Tempo (${env.APP_HOST})`.slice(0, 34),
    url: origin,
    callback_urls: [`${origin}/api/auth/callback/github`],
    redirect_url: `${origin}/setup/github/callback`,
    setup_url: `${origin}/setup/github/installed`,
    public: false,
    hook_attributes: { url: `${origin}/`, active: false },
    default_permissions: {
      email_addresses: "read",
      contents: "write",
      pull_requests: "write",
      metadata: "read",
      checks: "read",
      actions: "read",
      issues: "read",
    },
  };
};

const setupPage = (env: Env, token: string): Response => {
  const json = escapeHtml(JSON.stringify(manifest(env)));
  const t = encodeURIComponent(token);
  return html(`<h1>Set up Tempo</h1>
<p>Create the GitHub App that Tempo uses for sign-in and repo access. GitHub asks you to confirm.</p>
<form id="personal" method="post" action="https://github.com/settings/apps/new?state=${t}">
  <input type="hidden" name="manifest" value="${json}">
  <button type="submit">Create the GitHub App on my account</button>
</form>
<p>Or create it on an organization:</p>
<form id="org" method="post" onsubmit="this.action='https://github.com/organizations/'+encodeURIComponent(this.org.value)+'/settings/apps/new?state=${t}'">
  <input name="org" placeholder="organization" required>
  <input type="hidden" name="manifest" value="${json}">
  <button type="submit">Create on organization</button>
</form>`);
};

/** Unauthenticated: whether the App exists, and its install link (both public facts). */
export const handleSetupStatus = async (env: Env): Promise<Response> => {
  const config = await getGithubAppConfig(env);
  const status: AppSetupStatus = {
    configured: config !== null,
    installUrl: config ? `https://github.com/apps/${config.slug}/installations/new` : null,
  };
  return Response.json(status);
};
