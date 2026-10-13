import { GhInstallation, GhRepo, GhPull } from "@tempo/protocol";
import { Schema, SchemaGetter } from "effect";
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
  const res = await githubFetch(
    {
      method: "POST",
      path: `/app/installations/${installationId}/access_tokens`,
      token: await appJwt(config),
      body: repoIds
        ? { repository_ids: repoIds, permissions: TOKEN_PERMISSIONS }
        : { permissions: TOKEN_PERMISSIONS },
    },
    Schema.Struct({ token: Schema.String, expires_at: Schema.String }),
  );

  return { token: res.token, expiresAt: Date.parse(res.expires_at) };
};

export const listAppInstallations = async (config: GithubAppConfig): Promise<GhInstallation[]> =>
  githubPaginate(
    { path: "/app/installations", token: await appJwt(config) },
    1000,
    Schema.Array(GhInstallation),
  );

export const listInstallationRepos = async (token: string): Promise<GhRepo[]> =>
  githubPaginate(
    { path: "/installation/repositories", token },
    5000,
    Schema.Struct({ repositories: Schema.Array(GhRepo) }).pipe(
      Schema.decodeTo(Schema.Array(GhRepo), {
        decode: SchemaGetter.transform((page) => page.repositories),
        encode: SchemaGetter.transform((repositories) => ({ repositories })),
      }),
    ),
  );

export const getRepoById = (token: string, repoId: number) =>
  githubFetch({ path: `/repositories/${repoId}`, token }, GhRepo);

export const getUserById = (token: string, id: string) =>
  githubFetch(
    { path: `/user/${id}`, token },
    Schema.Struct({ login: Schema.String, name: Schema.NullOr(Schema.String), id: Schema.Number }),
  );

export { GhInstallation, GhRepo, GhPull };
