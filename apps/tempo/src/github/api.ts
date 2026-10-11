import type { GithubAppConfig } from "../do/credential.ts";
import { appJwt } from "./app.ts";
import { githubFetch, githubPaginate } from "./client.ts";

/** Permissions every installation token gets (01, Credentials and egress). */
export const TOKEN_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
  checks: "read",
  actions: "read",
  issues: "read",
} as const;

export interface InstallationToken {
  readonly token: string;
  readonly expiresAt: number;
}

export const mintInstallationToken = async (
  config: GithubAppConfig,
  installationId: number,
  repoIds?: ReadonlyArray<number>,
): Promise<InstallationToken> => {
  const res = await githubFetch<{ token: string; expires_at: string }>({
    method: "POST",
    path: `/app/installations/${installationId}/access_tokens`,
    token: await appJwt(config),
    body: repoIds ? { repository_ids: repoIds, permissions: TOKEN_PERMISSIONS } : { permissions: TOKEN_PERMISSIONS },
  });
  return { token: res.token, expiresAt: Date.parse(res.expires_at) };
};

export interface GhInstallation {
  readonly id: number;
  readonly account: { readonly login: string; readonly type: string } | null;
  readonly suspended_at: string | null;
}

export const listAppInstallations = async (config: GithubAppConfig): Promise<GhInstallation[]> =>
  githubPaginate<GhInstallation>({ path: "/app/installations", token: await appJwt(config) }, 1000);

export interface GhRepo {
  readonly id: number;
  readonly name: string;
  readonly owner: { readonly login: string };
  readonly default_branch: string;
  readonly private: boolean;
}

export const listInstallationRepos = async (token: string): Promise<GhRepo[]> =>
  githubPaginate<GhRepo>(
    { path: "/installation/repositories", token },
    5000,
    (page) => (page as { repositories: GhRepo[] }).repositories,
  );

export const getRepoById = (token: string, repoId: number) => githubFetch<GhRepo>({ path: `/repositories/${repoId}`, token });

export const getUserById = (token: string, id: string) =>
  githubFetch<{ login: string; name: string | null; id: number }>({ path: `/user/${id}`, token });

export interface GhPull {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly merged: boolean;
  readonly merged_at: string | null;
  readonly html_url: string;
  readonly head: { readonly ref: string; readonly sha: string; readonly repo: { readonly id: number } | null };
  readonly base: { readonly ref: string };
}
