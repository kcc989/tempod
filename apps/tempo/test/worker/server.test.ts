import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  ApiMeta,
  CloseCode,
  CredentialStatus,
  PLACEHOLDER,
  Project,
  WorkspaceDetail,
  WorkspaceSummary,
  newId,
  type FnName,
} from "@tempo/protocol";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import { SYSTEM_CREDENTIALS, GITHUB_APP_KEYS, type GithubAppConfig } from "../../src/do/credential.ts";
import { clearGithubAppConfigCache } from "../../src/github/app.ts";
import { handleAttachment, handleAttachmentRead } from "../../src/http/attachments.ts";
import { handleChannel } from "../../src/http/channels.ts";
import { handleApiV1 } from "../../src/http/native.ts";
import { handlePreview } from "../../src/http/preview.ts";
import { handleSetup, handleSetupStatus } from "../../src/http/setup.ts";
import { runFn } from "../../src/server/run.ts";
import { bytesToBase64 } from "../../src/lib/crypto.ts";
import {
  DEFAULT_EFFECTIVE,
  OWNER_GITHUB_ID,
  internals,
  seedCredentials,
  installFakes,
  FakeTempod,
  seedProject,
  seedWorkspace,
  waitFor,
  type Seeded,
} from "./fakes.ts";

/**
 * Worker-side server functions, auth and HTTP routes: 02 (Server functions, Credentials),
 * 03 (Create a workspace), 05 (Authentication and authorization, Preview access, GitHub App
 * setup, Egress control), 07 (Server changes for native clients) and 01 (TempoOutbound).
 */

type Row = Record<string, any>;
type Res = { readonly ok: boolean };
type ErrorBody = { code: string; message: string; detail?: string };

const BEARER = { allowCookie: false, allowBearer: true } as const;
const COOKIE = { allowCookie: true, allowBearer: false } as const;
const APP_ORIGIN = "https://tempo.test";
const ULID = /^[0-9a-hjkmnp-tv-z]{26}$/;

const ok = (r: Res): any => {
  if (!r.ok) {
    const e = (r as unknown as { error: ErrorBody }).error;
    throw new Error(`expected ok, got ${e.code}: ${e.message} ${e.detail ?? ""}`);
  }
  return (r as unknown as { value: unknown }).value;
};
const errOf = (r: Res): ErrorBody => {
  if (r.ok)
    throw new Error(`expected an error, got ${JSON.stringify((r as unknown as { value: unknown }).value)}`);
  return (r as unknown as { error: ErrorBody }).error;
};
const codeOf = (r: Res): string => (r.ok ? "OK" : (r as unknown as { error: ErrorBody }).error.code);

const conforms = (schema: Schema.Top, value: unknown): boolean =>
  Schema.decodeUnknownExit(schema as unknown as Schema.Decoder<unknown>)(value)._tag === "Success";

// ---------- sessions (Better Auth rows in D1) ----------

const randomToken = (n = 32): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => alphabet[b % alphabet.length]).join("");
};

/** Inserts a Better Auth session row and returns its raw token (accepted by the bearer plugin). */
const signIn = async (userId: string, expiresInMs = 86_400_000): Promise<string> => {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(newId(), now + expiresInMs, token, now, now, userId)
    .run();
  return token;
};

/** The browser cookie for a session token: `<token>.<base64 HMAC-SHA256>`, URI-encoded. */
const sessionCookie = async (token: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token)));
  return `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${btoa(String.fromCharCode(...sig))}`)}`;
};

/** A user whose GitHub account id is not TEMPO_OWNER_GITHUB_ID. */
const seedStranger = async (): Promise<{ userId: string; token: string }> => {
  const userId = `user-${newId()}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Stranger', ?, 1, ?, ?)",
    ).bind(userId, `${userId}@example.com`, now, now),
    env.DB.prepare(
      "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, '9999', 'github', ?, ?, ?)",
    ).bind(`acc-${userId}`, userId, now, now),
  ]);
  return { userId, token: await signIn(userId) };
};

type Owner = Seeded & { readonly token: string };
const owner = async (opts: { settingsJson?: string } = {}): Promise<Owner> => {
  const seeded = await seedProject(opts);
  return { ...seeded, token: await signIn(seeded.userId) };
};

const bearer = (token: string) => new Headers({ Authorization: `Bearer ${token}` });
const call = (name: FnName, who: { token: string } | null, input: unknown = {}) =>
  runFn(name, env, who ? bearer(who.token) : new Headers(), input, BEARER);

// ---------- D1 helpers ----------

const d1Row = (sql: string, ...binds: Array<string | number | null>) =>
  env.DB.prepare(sql)
    .bind(...binds)
    .first<Row>();
const d1Rows = async (sql: string, ...binds: Array<string | number | null>) =>
  (
    await env.DB.prepare(sql)
      .bind(...binds)
      .all<Row>()
  ).results;

const insertWorkspaceRow = async (o: {
  projectId: string;
  userId: string;
  slug: string;
  branch?: string;
  archivedAt?: number | null;
  lastActivityAt?: number;
  state?: string;
}): Promise<string> => {
  const id = newId();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO workspaces (id, project_id, user_id, slug, title, branch, base_branch, state, attention, default_agent, pinned, last_activity_at, created_at, archived_at, summary_rev) VALUES (?, ?, ?, ?, ?, ?, 'main', ?, 'none', 'claude', 0, ?, ?, ?, 1)",
  )
    .bind(
      id,
      o.projectId,
      o.userId,
      o.slug,
      o.slug,
      o.branch ?? `tempo/${o.slug}`,
      o.state ?? (o.archivedAt ? "archived" : "ready"),
      o.lastActivityAt ?? now,
      now,
      o.archivedAt ?? null,
    )
    .run();
  return id;
};

const insertProjectRow = async (
  userId: string,
  installationId: number,
  repoId: number,
  sortOrder: number,
  name = "other",
): Promise<string> => {
  const id = newId();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO projects (id, user_id, installation_id, repo_id, repo_owner, repo_name, default_branch, settings_json, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 'acme', ?, 'main', '{}', ?, ?, ?)",
  )
    .bind(id, userId, installationId, repoId, name, sortOrder, now, now)
    .run();
  return id;
};

const doRows = (
  stub: DurableObjectStub<WorkspaceDO>,
  query: string,
  ...binds: Array<string | number | null>
): Promise<Row[]> =>
  runInDurableObject(
    stub,
    (_i: WorkspaceDO, state: DurableObjectState) =>
      state.storage.sql.exec(query, ...binds).toArray() as Row[],
  );

// ---------- GitHub (mocked https://api.github.com) ----------

interface Recorded {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: any;
}

const APP = {
  appId: "123456",
  slug: "tempo-test",
  clientId: "Iv1.testclient",
  clientSecret: "client-secret-test",
};

const gh = {
  requests: [] as Recorded[],
  upstream: [] as Recorded[],
  installations: [] as Array<{
    id: number;
    account: { login: string; type: string } | null;
    suspended_at: string | null;
  }>,
  installationsStatus: 200,
  repos: new Map<number, Row>(),
  branches: new Set<string>(["main"]),
  branchListStatus: 200,
  pulls: new Map<number, Row>(),
  tokens: [] as Array<{ installationId: number; body: any; token: string }>,
  publicKey: null as CryptoKey | null,
  privatePem: "",
  appId: APP.appId,
  conversion: null as Row | null,
};

const b64urlDecode = (s: string): Uint8Array<ArrayBuffer> => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

/** Checks the App JWT: RS256 signed by the configured key, iss = app id, not expired. */
const verifyAppJwt = async (req: Request): Promise<boolean> => {
  const auth = req.headers.get("Authorization") ?? "";
  const m = /^Bearer ([^.]+)\.([^.]+)\.([^.]+)$/.exec(auth);
  if (!m || !gh.publicKey) return false;
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    gh.publicKey,
    b64urlDecode(m[3]!),
    new TextEncoder().encode(`${m[1]}.${m[2]}`),
  );
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(m[2]!))) as {
    iss: string;
    exp: number;
    iat: number;
  };
  return (
    valid && payload.iss === gh.appId && payload.exp * 1000 > Date.now() && payload.exp - payload.iat <= 600
  );
};

const isInstallationToken = (req: Request) =>
  (req.headers.get("Authorization") ?? "").startsWith("Bearer ghs_");

const githubApi = async (req: Request, url: URL, body: any): Promise<Response> => {
  const p = url.pathname;
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  const notFound = () => json({ message: "Not Found" }, 404);
  let m: RegExpExecArray | null;
  if ((m = /^\/app-manifests\/([^/]+)\/conversions$/.exec(p)) && req.method === "POST") {
    return gh.conversion ? json(gh.conversion, 201) : notFound();
  }
  if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p)) && req.method === "POST") {
    if (!(await verifyAppJwt(req))) return json({ message: "Bad credentials" }, 401);
    const token = `ghs_${m[1]}_${gh.tokens.length + 1}`;
    gh.tokens.push({ installationId: Number(m[1]), body, token });
    return json({ token, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
  }
  if (p === "/app/installations" && req.method === "GET") {
    if (!(await verifyAppJwt(req))) return json({ message: "Bad credentials" }, 401);
    if (gh.installationsStatus !== 200) return json({ message: "Forbidden" }, gh.installationsStatus);
    return json(gh.installations);
  }
  if (!isInstallationToken(req)) return json({ message: "Bad credentials" }, 401);
  if ((m = /^\/repositories\/(\d+)$/.exec(p))) {
    const repo = gh.repos.get(Number(m[1]));
    return repo ? json(repo) : notFound();
  }
  if ((m = /^\/user\/(\d+)$/.exec(p)))
    return json({ login: "octo-owner", name: "Octo Owner", id: Number(m[1]) });
  if (p === "/installation/repositories")
    return json({ total_count: gh.repos.size, repositories: [...gh.repos.values()] });
  if (p === "/repos/acme/app/branches") {
    if (gh.branchListStatus !== 200) return json({ message: "Forbidden" }, gh.branchListStatus);
    return json([...gh.branches].map((name) => ({ name })));
  }
  if ((m = /^\/repos\/acme\/app\/branches\/(.+)$/.exec(p))) {
    const name = decodeURIComponent(m[1]!);
    return gh.branches.has(name) ? json({ name }) : json({ message: "Branch not found" }, 404);
  }
  if (p === "/repos/acme/app/pulls")
    return json([...gh.pulls.values()].filter((pr) => pr["state"] === "open"));
  if ((m = /^\/repos\/acme\/app\/pulls\/(\d+)$/.exec(p))) {
    const pr = gh.pulls.get(Number(m[1]));
    return pr ? json(pr) : notFound();
  }
  // Anything else is a container request forwarded by TempoOutbound (rule 3).
  return json({ forwarded: true });
};

const pull = (number: number, headRef: string, headRepoId: number | null, baseRef = "main"): Row => ({
  number,
  title: `PR ${number}`,
  state: "open",
  draft: false,
  merged: false,
  merged_at: null,
  html_url: `https://github.com/acme/app/pull/${number}`,
  head: { ref: headRef, sha: "a".repeat(40), repo: headRepoId === null ? null : { id: headRepoId } },
  base: { ref: baseRef },
});

const pemOf = (der: ArrayBuffer, label: string): string =>
  `-----BEGIN ${label}-----\n${bytesToBase64(new Uint8Array(der)).replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;

const putAppConfig = async (overrides: Partial<typeof APP> = {}) => {
  await env.CREDENTIALS.getByName(SYSTEM_CREDENTIALS).putGithubAppConfig({
    ...APP,
    ...overrides,
    privateKey: gh.privatePem,
  });
  clearGithubAppConfigCache();
};

const removeAppConfig = async () => {
  const system = env.CREDENTIALS.getByName(SYSTEM_CREDENTIALS);
  for (const key of Object.values(GITHUB_APP_KEYS)) await system.deleteSecret(key);
  clearGithubAppConfigCache();
};

/** The system App config before this file ran, restored afterwards in case storage is shared. */
let priorAppConfig: GithubAppConfig | null = null;

beforeAll(async () => {
  priorAppConfig = await env.CREDENTIALS.getByName(SYSTEM_CREDENTIALS).getGithubAppConfig();
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  gh.publicKey = pair.publicKey;
  gh.privatePem = pemOf(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
    "PRIVATE KEY",
  );
  await putAppConfig();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const text = req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    const rec = { method: req.method, url, headers: req.headers, body };
    if (url.hostname === "api.github.com") {
      gh.requests.push(rec);
      return githubApi(req, url, body);
    }
    gh.upstream.push(rec);
    return new Response(`upstream ${url.hostname}`, { status: 200 });
  });
});

afterAll(async () => {
  if (priorAppConfig) {
    await env.CREDENTIALS.getByName(SYSTEM_CREDENTIALS).putGithubAppConfig({ ...priorAppConfig });
    clearGithubAppConfigCache();
  } else {
    await removeAppConfig();
  }
  vi.restoreAllMocks();
});

// ======================================================================
// 02, Server functions: rules for every server function; 05, Authentication
// ======================================================================

describe("auth middleware (02, Rules for every server function; 05, Authentication and authorization)", () => {
  it("returns UNAUTHENTICATED without a session", async () => {
    const res = await call("listProjects", null);
    expect(errOf(res)).toMatchObject({ code: "UNAUTHENTICATED", message: "Sign in to continue." });
  });

  it("returns UNAUTHENTICATED for an unknown bearer token", async () => {
    expect(codeOf(await call("listProjects", { token: randomToken() }))).toBe("UNAUTHENTICATED");
  });

  it("returns UNAUTHENTICATED for an expired session", async () => {
    const seeded = await seedProject();
    const token = await signIn(seeded.userId, -60_000);
    expect(codeOf(await call("listProjects", { token }))).toBe("UNAUTHENTICATED");
  });

  it("returns FORBIDDEN for a signed-in user whose GitHub id is not TEMPO_OWNER_GITHUB_ID", async () => {
    const stranger = await seedStranger();
    const res = await call("listProjects", stranger);
    // 02 Error codes: FORBIDDEN, "This Tempo belongs to someone else."
    expect(errOf(res)).toMatchObject({ code: "FORBIDDEN", message: "This Tempo belongs to someone else." });
  });

  it("runs the auth check before the schema decode", async () => {
    // 02: "An auth middleware runs first."
    expect(codeOf(await call("linkProject", null, { installationId: "nope" }))).toBe("UNAUTHENTICATED");
    const stranger = await seedStranger();
    expect(codeOf(await call("linkProject", stranger, { installationId: "nope" }))).toBe("FORBIDDEN");
  });

  it("returns VALIDATION_FAILED when the input fails its schema", async () => {
    const o = await owner();
    expect(codeOf(await call("linkProject", o, { installationId: "1", repoId: 2 }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(codeOf(await call("createWorkspace", o, { projectId: o.projectId }))).toBe("VALIDATION_FAILED");
    expect(
      codeOf(
        await call("createWorkspace", o, { projectId: o.projectId, source: { kind: "tag", tag: "v1" } }),
      ),
    ).toBe("VALIDATION_FAILED");
    expect(codeOf(await call("listWorkspaces", o, { includeArchived: "yes" }))).toBe("VALIDATION_FAILED");
    expect(codeOf(await call("getWorkspace", o, {}))).toBe("VALIDATION_FAILED");
  });

  it("accepts the owner's session cookie when cookies are allowed (the web wrapper)", async () => {
    const o = await owner();
    const headers = new Headers({ Cookie: await sessionCookie(o.token) });
    const res = await runFn("listProjects", env, headers, {}, COOKIE);
    expect(ok(res).map((p: Row) => p["id"])).toEqual([o.projectId]);
  });
});

// ======================================================================
// 02, Projects and GitHub
// ======================================================================

describe("projects and GitHub (02, Projects and GitHub)", () => {
  it("listProjects returns the user's projects as Project, ordered by sort_order", async () => {
    const o = await owner();
    const second = await insertProjectRow(o.userId, o.installationId, o.repoId + 50_000, 0, "web");
    const other = await owner();
    const list = ok(await call("listProjects", o));
    expect(list.map((p: Row) => p["id"])).toEqual([second, o.projectId]);
    expect(list.every((p: unknown) => conforms(Project, p))).toBe(true);
    expect(list[1]).toEqual({
      id: o.projectId,
      installationId: o.installationId,
      repoId: o.repoId,
      owner: "acme",
      name: "app",
      defaultBranch: "main",
      settings: {},
      sortOrder: 1,
    });
    expect(list.map((p: Row) => p["id"])).not.toContain(other.projectId);
  });

  it("listInstallations syncs D1 from GET /app/installations, then lists live ones", async () => {
    const o = await owner();
    // An installation the user had that GitHub no longer lists.
    await env.DB.prepare(
      "INSERT INTO github_installations (id, user_id, installation_id, account_login, account_type, created_at) VALUES (?, ?, 555099, 'gone', 'User', ?)",
    )
      .bind(newId(), o.userId, Date.now())
      .run();
    gh.installations = [
      { id: o.installationId, account: { login: "acme-renamed", type: "Organization" }, suspended_at: null },
      { id: 555001, account: { login: "octo-user", type: "User" }, suspended_at: null },
      {
        id: 555002,
        account: { login: "frozen-org", type: "Organization" },
        suspended_at: "2026-01-02T03:04:05Z",
      },
    ];
    const before = gh.requests.length;
    const list = ok(await call("listInstallations", o));
    const appCall = gh.requests.slice(before).find((r) => r.url.pathname === "/app/installations");
    expect(appCall?.method).toBe("GET");
    expect(list).toEqual(
      expect.arrayContaining([
        { installationId: o.installationId, accountLogin: "acme-renamed", accountType: "Organization" },
        { installationId: 555001, accountLogin: "octo-user", accountType: "User" },
      ]),
    );
    expect(list).toHaveLength(2);
    const synced = await d1Row("SELECT * FROM github_installations WHERE installation_id = 555001");
    expect(synced).toMatchObject({
      user_id: o.userId,
      account_login: "octo-user",
      account_type: "User",
      suspended_at: null,
    });
    const suspended = await d1Row("SELECT * FROM github_installations WHERE installation_id = 555002");
    expect(suspended?.["suspended_at"]).toBe(Date.parse("2026-01-02T03:04:05Z"));
    const renamed = await d1Row(
      "SELECT account_login FROM github_installations WHERE installation_id = ?",
      o.installationId,
    );
    expect(renamed?.["account_login"]).toBe("acme-renamed");
    gh.installations = [];
  });

  it("GitHub's setup_url stores the new installation for a signed-in owner (05 setup step 5)", async () => {
    const o = await owner();
    gh.installations = [
      { id: o.installationId, account: { login: "acme", type: "Organization" }, suspended_at: null },
      { id: 556001, account: { login: "fresh-org", type: "Organization" }, suspended_at: null },
    ];
    const anonymous = await setup("/setup/github/installed?installation_id=556001&setup_action=install");
    expect(anonymous.status).toBe(302);
    expect(await d1Row("SELECT * FROM github_installations WHERE installation_id = 556001")).toBeNull();
    const res = await setup("/setup/github/installed?installation_id=556001&setup_action=install", {
      headers: { Cookie: await sessionCookie(o.token) },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://tempo.test/");
    expect(await d1Row("SELECT * FROM github_installations WHERE installation_id = 556001")).toMatchObject({
      user_id: o.userId,
      account_login: "fresh-org",
    });
    gh.installations = [];
  });

  it("listInstallations returns GITHUB_API_ERROR when GitHub refuses", async () => {
    const o = await owner();
    gh.installationsStatus = 403;
    try {
      expect(codeOf(await call("listInstallations", o))).toBe("GITHUB_API_ERROR");
    } finally {
      gh.installationsStatus = 200;
    }
  });

  it("listInstallationRepos maps GitHub repos and refuses another user's installation", async () => {
    const o = await owner();
    gh.repos.set(811_001, {
      id: 811_001,
      name: "docs",
      owner: { login: "acme" },
      default_branch: "trunk",
      private: true,
    });
    const repos = ok(await call("listInstallationRepos", o, { installationId: o.installationId }));
    expect(repos).toContainEqual({
      repoId: 811_001,
      owner: "acme",
      name: "docs",
      defaultBranch: "trunk",
      private: true,
    });
    const other = await owner();
    expect(codeOf(await call("listInstallationRepos", o, { installationId: other.installationId }))).toBe(
      "NOT_FOUND",
    );
  });

  it("linkProject inserts the project row from GitHub's repo and returns a Project", async () => {
    const o = await owner();
    gh.repos.set(812_345, {
      id: 812_345,
      name: "web",
      owner: { login: "acme" },
      default_branch: "trunk",
      private: true,
    });
    const before = gh.tokens.length;
    const project = ok(await call("linkProject", o, { installationId: o.installationId, repoId: 812_345 }));
    expect(conforms(Project, project)).toBe(true);
    expect(project).toMatchObject({
      installationId: o.installationId,
      repoId: 812_345,
      owner: "acme",
      name: "web",
      defaultBranch: "trunk",
      settings: {},
      sortOrder: 2,
    });
    expect(project.id).toMatch(ULID);
    const row = await d1Row("SELECT * FROM projects WHERE id = ?", project.id);
    expect(row).toMatchObject({
      user_id: o.userId,
      installation_id: o.installationId,
      repo_id: 812_345,
      repo_owner: "acme",
      repo_name: "web",
      default_branch: "trunk",
      settings_json: "{}",
    });
    // The token used for the lookup is scoped to the one repo (01, Credentials and egress).
    const minted = gh.tokens.slice(before).find((t) => t.installationId === o.installationId);
    expect(minted?.body).toMatchObject({ repository_ids: [812_345] });
  });

  it("linkProject returns PROJECT_EXISTS when the repo is already a project", async () => {
    const o = await owner();
    const res = await call("linkProject", o, { installationId: o.installationId, repoId: o.repoId });
    expect(errOf(res)).toMatchObject({ code: "PROJECT_EXISTS", message: "This repo is already a project." });
  });

  it("linkProject returns REPO_NOT_ACCESSIBLE when GitHub answers 404", async () => {
    const o = await owner();
    const res = await call("linkProject", o, { installationId: o.installationId, repoId: 899_999 });
    expect(codeOf(res)).toBe("REPO_NOT_ACCESSIBLE");
    expect(await d1Row("SELECT id FROM projects WHERE repo_id = 899999")).toBeNull();
  });

  it("linkProject returns NOT_FOUND for an installation the user does not have", async () => {
    const o = await owner();
    const other = await owner();
    gh.repos.set(813_000, {
      id: 813_000,
      name: "x",
      owner: { login: "acme" },
      default_branch: "main",
      private: false,
    });
    expect(
      codeOf(await call("linkProject", o, { installationId: other.installationId, repoId: 813_000 })),
    ).toBe("NOT_FOUND");
  });

  it("updateProjectSettings stores the overrides in settings_json and returns the Project", async () => {
    const o = await owner();
    const settings = {
      git: { branch_prefix: "feat/" },
      environment: {
        sleep_after_idle_minutes: 30,
        egress_policy: "allowlist",
        egress_allowlist: ["*.example.com"],
      },
      environment_variables: { NODE_ENV: "test" },
    };
    const project = ok(await call("updateProjectSettings", o, { projectId: o.projectId, settings }));
    expect(project.settings).toEqual(settings);
    const row = await d1Row("SELECT settings_json FROM projects WHERE id = ?", o.projectId);
    expect(JSON.parse(String(row?.["settings_json"]))).toEqual(settings);
    const listed = ok(await call("listProjects", o));
    expect(listed[0].settings).toEqual(settings);
  });

  it("updateProjectSettings returns NOT_FOUND for another user's project", async () => {
    const o = await owner();
    const other = await owner();
    const res = await call("updateProjectSettings", o, { projectId: other.projectId, settings: {} });
    expect(codeOf(res)).toBe("NOT_FOUND");
  });

  // Regression (fixed): the input schema decodes `settings` as a SettingsLayer before the handler runs, so a bad
  // value fails with VALIDATION_FAILED and the handler's SETTINGS_INVALID path is unreachable.
  it("updateProjectSettings returns SETTINGS_INVALID for a value out of range", async () => {
    // 02 Projects and GitHub: updateProjectSettings, Errors: SETTINGS_INVALID ("Settings failed validation").
    const o = await owner();
    const res = await call("updateProjectSettings", o, {
      projectId: o.projectId,
      settings: { environment: { sleep_after_idle_minutes: 1 } },
    });
    expect(codeOf(res)).toBe("SETTINGS_INVALID");
  });

  // Regression (fixed): unknown keys are stripped by the input decode, so they are silently dropped and stored
  // without them instead of reaching validateOverrides, which rejects them with SETTINGS_INVALID.
  it("updateProjectSettings returns SETTINGS_INVALID for unknown keys and stores nothing", async () => {
    const o = await owner();
    const res = await call("updateProjectSettings", o, {
      projectId: o.projectId,
      settings: { git: { branch_prefix: "x/", bogus: true }, nonsense: 1 },
    });
    expect(codeOf(res)).toBe("SETTINGS_INVALID");
    const row = await d1Row("SELECT settings_json FROM projects WHERE id = ?", o.projectId);
    expect(row?.["settings_json"]).toBe("{}");
  });

  it("updateProjectSettings rejects a bad value and leaves settings_json unchanged", async () => {
    const o = await owner();
    const res = await call("updateProjectSettings", o, {
      projectId: o.projectId,
      settings: { environment: { instance: "standard-9" } },
    });
    expect(res.ok).toBe(false);
    expect(["SETTINGS_INVALID", "VALIDATION_FAILED"]).toContain(codeOf(res));
    const row = await d1Row("SELECT settings_json FROM projects WHERE id = ?", o.projectId);
    expect(row?.["settings_json"]).toBe("{}");
  });

  it("unlinkProject returns PROJECT_HAS_WORKSPACES while a live workspace exists", async () => {
    const o = await owner();
    await insertWorkspaceRow({ projectId: o.projectId, userId: o.userId, slug: "lisbon" });
    const res = await call("unlinkProject", o, { projectId: o.projectId });
    expect(errOf(res)).toMatchObject({
      code: "PROJECT_HAS_WORKSPACES",
      message: "Archive this project's workspaces first.",
    });
    expect(await d1Row("SELECT id FROM projects WHERE id = ?", o.projectId)).not.toBeNull();
  });

  it("unlinkProject deletes the project and its secrets", async () => {
    const o = await owner();
    ok(
      await call("setProjectSecret", o, { projectId: o.projectId, name: "API_TOKEN", value: "s3cret-value" }),
    );
    ok(await call("unlinkProject", o, { projectId: o.projectId }));
    expect(await d1Row("SELECT id FROM projects WHERE id = ?", o.projectId)).toBeNull();
    expect(await env.CREDENTIALS.getByName(o.userId).listProjectEnvNames(o.projectId)).toEqual([]);
    expect(codeOf(await call("unlinkProject", o, { projectId: o.projectId }))).toBe("NOT_FOUND");
  });

  it("listBranches filters by query; GITHUB_API_ERROR when GitHub refuses", async () => {
    const o = await owner();
    gh.branches.add("feature/login");
    gh.branches.add("feature/pay");
    const branches = ok(await call("listBranches", o, { projectId: o.projectId, query: "FEATURE" }));
    expect(branches).toEqual(expect.arrayContaining([{ name: "feature/login" }, { name: "feature/pay" }]));
    expect(branches).not.toContainEqual({ name: "main" });
    gh.branchListStatus = 403;
    try {
      expect(codeOf(await call("listBranches", o, { projectId: o.projectId }))).toBe("GITHUB_API_ERROR");
    } finally {
      gh.branchListStatus = 200;
    }
  });

  it("listOpenPullRequests returns {number, title, headBranch}", async () => {
    const o = await owner();
    gh.pulls.set(41, pull(41, "topic-41", o.repoId));
    const prs = ok(await call("listOpenPullRequests", o, { projectId: o.projectId }));
    expect(prs).toContainEqual({ number: 41, title: "PR 41", headBranch: "topic-41" });
    gh.pulls.delete(41);
  });
});

// ======================================================================
// 02, Workspaces; 03, Create a workspace
// ======================================================================

describe("listModels", () => {
  it("discovers the configured agent's models before any workspace or chat exists", async () => {
    const o = await owner();
    await env.CREDENTIALS.getByName(o.userId).putSecret("claude.oauth_token", "token");
    const stub = env.WORKSPACE.getByName(`models:${o.userId}`);
    const tempod = new FakeTempod();
    tempod.on("session.start", () => ({
      acpSessionId: "discovery",
      modes: [],
      availableCommands: [],
      capabilities: {},
      reloaded: false,
      handoff: false,
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "a",
          options: [
            {
              group: "group",
              name: "Group",
              options: [
                { value: "a", name: "Model A" },
                { value: "b", name: "Model B" },
              ],
            },
          ],
        },
      ],
    }));
    const { container } = await installFakes(stub, tempod);
    expect(ok(await call("listModels", o, {}))).toEqual([
      {
        agent: "claude",
        currentValue: "a",
        options: [
          { value: "a", name: "Model A" },
          { value: "b", name: "Model B" },
        ],
      },
    ]);
    expect(await d1Rows("SELECT id FROM workspaces WHERE user_id = ?", o.userId)).toEqual([]);
    expect(await doRows(stub, "SELECT id FROM sessions")).toEqual([]);
    expect(tempod.requestsOf("session.prompt")).toEqual([]);
    expect(tempod.requestsOf("session.close")).toHaveLength(1);
    expect(container.destroyed).toBe(1);
    await call("listModels", o, {});
    expect(tempod.requestsOf("session.start")).toHaveLength(1);
    const other = await owner();
    expect(ok(await call("listModels", other, {}))).toEqual([]);
  });
});

describe("createWorkspace (03, Create a workspace)", () => {
  it("picks the first unused city and the branch <branch_prefix><slug>, and returns a starting summary", async () => {
    const o = await owner();
    const first = ok(
      await call("createWorkspace", o, {
        projectId: o.projectId,
        source: { kind: "new", baseBranch: "main" },
      }),
    );
    expect(conforms(WorkspaceSummary, first)).toBe(true);
    expect(first).toMatchObject({
      projectId: o.projectId,
      slug: "lisbon",
      title: "lisbon",
      branch: "tempo/lisbon",
      baseBranch: "main",
      state: "starting",
      defaultAgent: "claude",
      archivedAt: null,
    });
    expect(first.id).toMatch(ULID);
    const second = ok(
      await call("createWorkspace", o, {
        projectId: o.projectId,
        source: { kind: "new", baseBranch: "main" },
      }),
    );
    expect(second).toMatchObject({ slug: "porto", branch: "tempo/porto" });
    const row = await d1Row("SELECT * FROM workspaces WHERE id = ?", first.id);
    expect(row).toMatchObject({
      project_id: o.projectId,
      user_id: o.userId,
      slug: "lisbon",
      branch: "tempo/lisbon",
      base_branch: "main",
    });
  });

  it("uses the project's git.branch_prefix override", async () => {
    const o = await owner({ settingsJson: JSON.stringify({ git: { branch_prefix: "feat/" } }) });
    const ws = ok(
      await call("createWorkspace", o, {
        projectId: o.projectId,
        source: { kind: "new", baseBranch: "main" },
      }),
    );
    expect(ws).toMatchObject({ slug: "lisbon", branch: "feat/lisbon" });
  });

  it("reuses a slug that only an archived workspace holds", async () => {
    // 03: "the first city name in the fixed list that no non-archived workspace in this project uses"
    const o = await owner();
    await insertWorkspaceRow({
      projectId: o.projectId,
      userId: o.userId,
      slug: "lisbon",
      archivedAt: Date.now() - 1000,
    });
    await insertWorkspaceRow({ projectId: o.projectId, userId: o.userId, slug: "porto" });
    const ws = ok(
      await call("createWorkspace", o, {
        projectId: o.projectId,
        source: { kind: "new", baseBranch: "main" },
      }),
    );
    expect(ws).toMatchObject({ slug: "lisbon", branch: "tempo/lisbon" });
  });

  it("sets the title to the first 60 characters of the prompt and honours the agent", async () => {
    const o = await owner();
    const text = `  ${"Refactor the billing module ".repeat(4)}`;
    const ws = ok(
      await call("createWorkspace", o, {
        projectId: o.projectId,
        source: { kind: "new", baseBranch: "main" },
        agent: "codex",
        model: "chosen-model",
        prompt: { text },
      }),
    );
    expect(ws.title).toBe(text.trim().slice(0, 60));
    expect(ws.defaultAgent).toBe("codex");
    const chat = await doRows(env.WORKSPACE.getByName(ws.id), "SELECT agent, config_json FROM sessions");
    expect(chat).toHaveLength(1);
    expect(JSON.parse(chat[0]!["config_json"])).toEqual({ model: "chosen-model" });
  });

  it("defaults the agent to the project's agent.default", async () => {
    const o = await owner({
      settingsJson: JSON.stringify({ agent: { default: "opencode", models: { opencode: "x/y" } } }),
    });
    const ws = ok(
      await call("createWorkspace", o, {
        projectId: o.projectId,
        source: { kind: "new", baseBranch: "main" },
      }),
    );
    expect(ws.defaultAgent).toBe("opencode");
  });

  it("passes the commit author <id>+<login>@users.noreply.github.com to the WorkspaceDO", async () => {
    // 03, repo.clone: name = the owner's GitHub name, else the login; email = <id>+<login>@users.noreply.github.com.
    const o = await owner();
    const ws = ok(
      await call("createWorkspace", o, {
        projectId: o.projectId,
        source: { kind: "new", baseBranch: "main" },
      }),
    );
    const author = await runInDurableObject(env.WORKSPACE.getByName(ws.id), (instance: WorkspaceDO) =>
      internals(instance).core.kv<{ name: string; email: string }>("author"),
    );
    expect(author).toEqual({
      name: "Octo Owner",
      email: `${OWNER_GITHUB_ID}+octo-owner@users.noreply.github.com`,
    });
  });

  it("source.kind 'branch' uses that branch and the project's default branch as base", async () => {
    const o = await owner();
    gh.branches.add("feature/checkout");
    const ws = ok(
      await call("createWorkspace", o, {
        projectId: o.projectId,
        source: { kind: "branch", branch: "feature/checkout" },
      }),
    );
    expect(ws).toMatchObject({ slug: "lisbon", branch: "feature/checkout", baseBranch: "main" });
  });

  it("source.kind 'branch' returns NOT_FOUND when the branch is not on origin", async () => {
    const o = await owner();
    const res = await call("createWorkspace", o, {
      projectId: o.projectId,
      source: { kind: "branch", branch: "no-such-branch" },
    });
    expect(codeOf(res)).toBe("NOT_FOUND");
    expect(await d1Rows("SELECT id FROM workspaces WHERE project_id = ?", o.projectId)).toHaveLength(0);
  });

  // Regression (fixed): drizzle wraps the D1 error as "Failed query: ..."; the UNIQUE text is only in e.cause, so
  // isUniqueViolation never matches and the index violation surfaces as INTERNAL.
  it("returns BRANCH_IN_USE when another live workspace has the branch", async () => {
    // 03 Create a workspace, step 4: "The partial unique index on (project_id, branch) rejects a
    // branch in use; map that to BRANCH_IN_USE."
    const o = await owner();
    gh.branches.add("feature/busy");
    await insertWorkspaceRow({
      projectId: o.projectId,
      userId: o.userId,
      slug: "lisbon",
      branch: "feature/busy",
    });
    const res = await call("createWorkspace", o, {
      projectId: o.projectId,
      source: { kind: "branch", branch: "feature/busy" },
    });
    expect(errOf(res)).toMatchObject({
      code: "BRANCH_IN_USE",
      message: "Another workspace uses this branch.",
    });
    expect(await d1Rows("SELECT id FROM workspaces WHERE project_id = ?", o.projectId)).toHaveLength(1);
  });

  // Regression (fixed): same cause as above (isUniqueViolation reads String(e), not e.cause).
  it("returns BRANCH_IN_USE for source 'new' when <prefix><slug> is held by a live workspace", async () => {
    const o = await owner();
    await insertWorkspaceRow({
      projectId: o.projectId,
      userId: o.userId,
      slug: "custom",
      branch: "tempo/lisbon",
    });
    const res = await call("createWorkspace", o, {
      projectId: o.projectId,
      source: { kind: "new", baseBranch: "main" },
    });
    expect(codeOf(res)).toBe("BRANCH_IN_USE");
  });

  it("a branch already held by a live workspace is refused and no row is inserted", async () => {
    const o = await owner();
    gh.branches.add("feature/held");
    await insertWorkspaceRow({
      projectId: o.projectId,
      userId: o.userId,
      slug: "lisbon",
      branch: "feature/held",
    });
    const res = await call("createWorkspace", o, {
      projectId: o.projectId,
      source: { kind: "branch", branch: "feature/held" },
    });
    expect(res.ok).toBe(false);
    expect(await d1Rows("SELECT id FROM workspaces WHERE project_id = ?", o.projectId)).toHaveLength(1);
  });

  it("allows a branch that only an archived workspace used", async () => {
    const o = await owner();
    gh.branches.add("feature/old");
    await insertWorkspaceRow({
      projectId: o.projectId,
      userId: o.userId,
      slug: "lisbon",
      branch: "feature/old",
      archivedAt: Date.now(),
    });
    const ws = ok(
      await call("createWorkspace", o, {
        projectId: o.projectId,
        source: { kind: "branch", branch: "feature/old" },
      }),
    );
    expect(ws.branch).toBe("feature/old");
  });

  it("source.kind 'pr' uses head.ref and the PR's base.ref", async () => {
    const o = await owner();
    gh.pulls.set(8, pull(8, "pr-branch-8", o.repoId, "develop"));
    const ws = ok(
      await call("createWorkspace", o, { projectId: o.projectId, source: { kind: "pr", number: 8 } }),
    );
    expect(ws).toMatchObject({ branch: "pr-branch-8", baseBranch: "develop", slug: "lisbon" });
    gh.pulls.delete(8);
  });

  it("source.kind 'pr' keeps the PR's number, state and title in D1 and the WorkspaceDO", async () => {
    // 03 Create 3–4 and init 1: number, title and state (as in Status polling); D1 pr_number and pr_state.
    const o = await owner();
    const cases: Array<[number, Row, string]> = [
      [21, { draft: true }, "draft"],
      [22, {}, "open"],
      [23, { state: "closed" }, "closed"],
      [24, { state: "closed", merged: true, merged_at: "2026-10-12T00:00:00Z" }, "merged"],
    ];
    for (const [number, patch, state] of cases) {
      gh.pulls.set(number, { ...pull(number, `pr-branch-${number}`, o.repoId), ...patch });
      const ws = ok(
        await call("createWorkspace", o, { projectId: o.projectId, source: { kind: "pr", number } }),
      );
      expect(ws).toMatchObject({ prNumber: number, prState: state });
      expect(await d1Row("SELECT pr_number, pr_state FROM workspaces WHERE id = ?", ws.id)).toEqual({
        pr_number: number,
        pr_state: state,
      });
      const stub = env.WORKSPACE.getByName(ws.id);
      expect(ok(await stub.getWorkspace({}))).toMatchObject({
        prNumber: number,
        prState: state,
        prTitle: `PR ${number}`,
      });
      expect(await doRows(stub, "SELECT pr_number, pr_state FROM workspace")).toEqual([
        { pr_number: number, pr_state: state },
      ]);
      gh.pulls.delete(number);
    }
    const plain = ok(
      await call("createWorkspace", o, {
        projectId: o.projectId,
        source: { kind: "new", baseBranch: "main" },
      }),
    );
    expect(plain).toMatchObject({ prNumber: null, prState: null });
    expect(await d1Row("SELECT pr_number, pr_state FROM workspaces WHERE id = ?", plain.id)).toEqual({
      pr_number: null,
      pr_state: null,
    });
  });

  it("source.kind 'pr' from a fork fails with VALIDATION_FAILED and the exact message", async () => {
    const o = await owner();
    gh.pulls.set(7, pull(7, "fork-branch", 1));
    const res = await call("createWorkspace", o, {
      projectId: o.projectId,
      source: { kind: "pr", number: 7 },
    });
    expect(errOf(res)).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Pull requests from forks are not supported.",
    });
    expect(await d1Rows("SELECT id FROM workspaces WHERE project_id = ?", o.projectId)).toHaveLength(0);
    gh.pulls.delete(7);
  });

  it("source.kind 'pr' returns NOT_FOUND for an unknown PR", async () => {
    const o = await owner();
    expect(
      codeOf(
        await call("createWorkspace", o, { projectId: o.projectId, source: { kind: "pr", number: 404 } }),
      ),
    ).toBe("NOT_FOUND");
  });

  it("returns NOT_FOUND for another user's project", async () => {
    const o = await owner();
    const other = await owner();
    const res = await call("createWorkspace", o, {
      projectId: other.projectId,
      source: { kind: "new", baseBranch: "main" },
    });
    expect(codeOf(res)).toBe("NOT_FOUND");
  });
});

describe("listWorkspaces and workspace functions (02, Workspaces)", () => {
  it("excludes archived workspaces unless includeArchived, newest activity first, own only", async () => {
    const o = await owner();
    const a = await insertWorkspaceRow({
      projectId: o.projectId,
      userId: o.userId,
      slug: "lisbon",
      lastActivityAt: 1_000,
    });
    const b = await insertWorkspaceRow({
      projectId: o.projectId,
      userId: o.userId,
      slug: "porto",
      lastActivityAt: 3_000,
    });
    const c = await insertWorkspaceRow({
      projectId: o.projectId,
      userId: o.userId,
      slug: "madrid",
      lastActivityAt: 2_000,
      archivedAt: 2_500,
    });
    const other = await owner();
    const d = await insertWorkspaceRow({ projectId: other.projectId, userId: other.userId, slug: "lisbon" });

    const live = ok(await call("listWorkspaces", o, {}));
    expect(live.map((w: Row) => w["id"])).toEqual([b, a]);
    expect(live.every((w: unknown) => conforms(WorkspaceSummary, w))).toBe(true);
    const all = ok(await call("listWorkspaces", o, { includeArchived: true }));
    expect(all.map((w: Row) => w["id"])).toEqual([b, c, a]);
    expect(all.find((w: Row) => w["id"] === c)).toMatchObject({ state: "archived", archivedAt: 2_500 });
    expect(all.map((w: Row) => w["id"])).not.toContain(d);
    const notArchived = ok(await call("listWorkspaces", o, { includeArchived: false }));
    expect(notArchived.map((w: Row) => w["id"])).toEqual([b, a]);
  });

  it("returns NOT_FOUND for another user's workspace and never calls its WorkspaceDO", async () => {
    const o = await owner();
    const other = await owner();
    const theirs = await insertWorkspaceRow({
      projectId: other.projectId,
      userId: other.userId,
      slug: "lisbon",
    });
    for (const [fn, input] of [
      ["getWorkspace", {}],
      ["setPinned", { pinned: true }],
      ["renameWorkspace", { title: "mine now" }],
      ["archiveWorkspace", {}],
      ["deleteWorkspace", {}],
      ["sendPrompt", { sessionId: "s", text: "hi", mentions: [], attachmentIds: [], reviewCommentIds: [] }],
    ] as const) {
      expect(codeOf(await call(fn, o, { workspaceId: theirs, ...input })), fn).toBe("NOT_FOUND");
    }
    expect(await d1Row("SELECT pinned, title FROM workspaces WHERE id = ?", theirs)).toMatchObject({
      pinned: 0,
      title: "lisbon",
    });
    expect(codeOf(await call("getWorkspace", o, { workspaceId: newId() }))).toBe("NOT_FOUND");
  });

  it("calls the WorkspaceDO for an owned workspace (getWorkspace, setPinned)", async () => {
    const o = await owner();
    const { workspaceId } = await seedWorkspace(o);
    const detail = ok(await call("getWorkspace", o, { workspaceId }));
    expect(conforms(WorkspaceDetail, detail)).toBe(true);
    expect(detail).toMatchObject({ id: workspaceId, projectId: o.projectId });
    ok(await call("setPinned", o, { workspaceId, pinned: true }));
    // 02: setPinned calls the WorkspaceDO, which writes `pinned` (Write rules for workspaces).
    await waitFor(
      async () => (await d1Row("SELECT pinned FROM workspaces WHERE id = ?", workspaceId))?.["pinned"] === 1,
    );
  });
});

// ======================================================================
// 02, Credentials
// ======================================================================

describe("credentials (02, Credentials)", () => {
  const CLAUDE_TOKEN = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz";

  it("getCredentialStatus reports set and updatedAt, never values", async () => {
    const o = await owner();
    const empty = ok(await call("getCredentialStatus", o));
    expect(conforms(CredentialStatus, empty)).toBe(true);
    expect(empty).toEqual({
      claude: { set: false, updatedAt: null },
      codex: { set: false, updatedAt: null, lastRefresh: null },
      openrouter: { set: false, updatedAt: null },
      anthropic: { set: false, updatedAt: null },
      openai: { set: false, updatedAt: null },
    });
    ok(await call("setClaudeToken", o, { token: CLAUDE_TOKEN }));
    ok(await call("setApiKey", o, { provider: "openrouter", key: "sk-or-v1-secretvalue" }));
    const status = ok(await call("getCredentialStatus", o));
    expect(status.claude.set).toBe(true);
    expect(typeof status.claude.updatedAt).toBe("number");
    expect(status.openrouter.set).toBe(true);
    expect(status.anthropic).toEqual({ set: false, updatedAt: null });
    const text = JSON.stringify(status);
    expect(text).not.toContain(CLAUDE_TOKEN);
    expect(text).not.toContain("sk-or-v1-secretvalue");
  });

  it("setClaudeToken stores the token under claude.oauth_token", async () => {
    const o = await owner();
    ok(await call("setClaudeToken", o, { token: CLAUDE_TOKEN }));
    expect(await env.CREDENTIALS.getByName(o.userId).getSecret("claude.oauth_token")).toBe(CLAUDE_TOKEN);
  });

  it("setClaudeToken rejects spaces, short and over-long tokens with VALIDATION_FAILED", async () => {
    // 02: `{token}`: no spaces, 20 to 4096 chars.
    const o = await owner();
    for (const token of [
      "sk-ant-oat01 abcdefghijklmnop",
      "short-token-123",
      "x".repeat(19),
      "x".repeat(4097),
      "",
    ]) {
      expect(codeOf(await call("setClaudeToken", o, { token })), token.slice(0, 30)).toBe(
        "VALIDATION_FAILED",
      );
    }
    expect(await env.CREDENTIALS.getByName(o.userId).getSecret("claude.oauth_token")).toBeNull();
    ok(await call("setClaudeToken", o, { token: "x".repeat(20) }));
    ok(await call("setClaudeToken", o, { token: "y".repeat(4096) }));
  });

  it("setCodexAuth validates auth.json and stores it with lastRefresh", async () => {
    const o = await owner();
    const bad = [
      "not json",
      JSON.stringify({ tokens: { access_token: "a" }, last_refresh: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ tokens: { access_token: "a", refresh_token: "r" } }),
      JSON.stringify({ last_refresh: "2026-01-01T00:00:00Z" }),
      "",
    ];
    for (const authJson of bad) {
      expect(codeOf(await call("setCodexAuth", o, { authJson })), authJson).toBe("VALIDATION_FAILED");
    }
    const authJson = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { access_token: "acc-token", refresh_token: "ref-token", id_token: "id" },
      last_refresh: "2026-09-01T10:00:00Z",
    });
    ok(await call("setCodexAuth", o, { authJson }));
    expect(await env.CREDENTIALS.getByName(o.userId).getSecret("codex.auth_json")).toBe(authJson);
    const status = ok(await call("getCredentialStatus", o));
    expect(status.codex).toMatchObject({ set: true, lastRefresh: Date.parse("2026-09-01T10:00:00Z") });
    expect(JSON.stringify(status)).not.toContain("acc-token");
  });

  it("setApiKey stores each provider's key under its exact secret key", async () => {
    const o = await owner();
    const creds = env.CREDENTIALS.getByName(o.userId);
    ok(await call("setApiKey", o, { provider: "openrouter", key: "sk-or-1" }));
    ok(await call("setApiKey", o, { provider: "anthropic", key: "sk-ant-api-2" }));
    ok(await call("setApiKey", o, { provider: "openai", key: "sk-openai-3" }));
    expect(await creds.getSecret("openrouter.api_key")).toBe("sk-or-1");
    expect(await creds.getSecret("anthropic.api_key")).toBe("sk-ant-api-2");
    expect(await creds.getSecret("openai.api_key")).toBe("sk-openai-3");
  });

  it("setApiKey returns VALIDATION_FAILED for an unknown provider or a bad key", async () => {
    const o = await owner();
    expect(codeOf(await call("setApiKey", o, { provider: "mistral", key: "k" }))).toBe("VALIDATION_FAILED");
    expect(codeOf(await call("setApiKey", o, { provider: "openai", key: "" }))).toBe("VALIDATION_FAILED");
    expect(codeOf(await call("setApiKey", o, { provider: "openai", key: "sk two parts" }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(await env.CREDENTIALS.getByName(o.userId).getSecret("openai.api_key")).toBeNull();
  });

  it("deleteCredential removes one secret and leaves the others", async () => {
    const o = await owner();
    const creds = env.CREDENTIALS.getByName(o.userId);
    ok(await call("setApiKey", o, { provider: "openrouter", key: "sk-or-1" }));
    ok(await call("setApiKey", o, { provider: "openai", key: "sk-openai-3" }));
    ok(await call("deleteCredential", o, { key: "openrouter.api_key" }));
    expect(await creds.getSecret("openrouter.api_key")).toBeNull();
    expect(await creds.getSecret("openai.api_key")).toBe("sk-openai-3");
    const status = ok(await call("getCredentialStatus", o));
    expect(status.openrouter).toEqual({ set: false, updatedAt: null });
    expect(codeOf(await call("deleteCredential", o, {}))).toBe("VALIDATION_FAILED");
  });

  it("setProjectSecret accepts names matching ^[A-Z_][A-Z0-9_]*$ and stores project.<id>.env.<NAME>", async () => {
    const o = await owner();
    for (const name of ["API_KEY", "_PRIVATE", "X1_2"]) {
      ok(await call("setProjectSecret", o, { projectId: o.projectId, name, value: `value-${name}` }));
    }
    const creds = env.CREDENTIALS.getByName(o.userId);
    expect(await creds.getSecret(`project.${o.projectId}.env.API_KEY`)).toBe("value-API_KEY");
    expect(await creds.getSecret(`project.${o.projectId}.env._PRIVATE`)).toBe("value-_PRIVATE");
  });

  it("setProjectSecret returns VALIDATION_FAILED for names outside the pattern", async () => {
    const o = await owner();
    for (const name of ["api_key", "1ABC", "A-B", "A B", "", "ÄPI"]) {
      expect(
        codeOf(await call("setProjectSecret", o, { projectId: o.projectId, name, value: "v" })),
        name,
      ).toBe("VALIDATION_FAILED");
    }
    expect(await env.CREDENTIALS.getByName(o.userId).listProjectEnvNames(o.projectId)).toEqual([]);
  });

  it("setProjectSecret and listProjectSecretNames return NOT_FOUND for another user's project", async () => {
    const o = await owner();
    const other = await owner();
    expect(
      codeOf(await call("setProjectSecret", o, { projectId: other.projectId, name: "A", value: "v" })),
    ).toBe("NOT_FOUND");
    expect(codeOf(await call("listProjectSecretNames", o, { projectId: other.projectId }))).toBe("NOT_FOUND");
    expect(codeOf(await call("deleteProjectSecret", o, { projectId: other.projectId, name: "A" }))).toBe(
      "NOT_FOUND",
    );
  });

  it("setProjectSecret and deleteProjectSecret send env.set to the project's live workspaces", async () => {
    // 02 tempod protocol: "whenever project env vars or secrets change, the DO sends env.set".
    const o = await owner();
    const { stub, tempod } = await seedWorkspace(o);
    await driveReady(stub);
    const sentBefore = tempod.requestsOf("env.set").length;
    ok(
      await call("setProjectSecret", o, { projectId: o.projectId, name: "STRIPE_KEY", value: "sk_test_123" }),
    );
    await waitFor(
      () => tempod.requestsOf("env.set").length > sentBefore,
      5000,
      "env.set after setProjectSecret",
    );
    expect(tempod.requestsOf("env.set").at(-1).env).toMatchObject({
      STRIPE_KEY: "sk_test_123",
      TEMPO_PORT: "3000",
    });
    const afterSet = tempod.requestsOf("env.set").length;
    ok(await call("deleteProjectSecret", o, { projectId: o.projectId, name: "STRIPE_KEY" }));
    await waitFor(
      () => tempod.requestsOf("env.set").length > afterSet,
      5000,
      "env.set after deleteProjectSecret",
    );
    expect(tempod.requestsOf("env.set").at(-1).env).not.toHaveProperty("STRIPE_KEY");
  });

  it("listProjectSecretNames returns names only, per project; deleteProjectSecret removes one", async () => {
    const o = await owner();
    const second = await insertProjectRow(o.userId, o.installationId, o.repoId + 60_000, 2);
    ok(await call("setProjectSecret", o, { projectId: o.projectId, name: "ZED", value: "zzz-secret" }));
    ok(await call("setProjectSecret", o, { projectId: o.projectId, name: "ALPHA", value: "aaa-secret" }));
    ok(await call("setProjectSecret", o, { projectId: second, name: "OTHER", value: "ooo-secret" }));
    const listed = ok(await call("listProjectSecretNames", o, { projectId: o.projectId }));
    expect(listed).toEqual({ names: ["ALPHA", "ZED"] });
    expect(JSON.stringify(listed)).not.toContain("secret");
    ok(await call("deleteProjectSecret", o, { projectId: o.projectId, name: "ZED" }));
    expect(ok(await call("listProjectSecretNames", o, { projectId: o.projectId }))).toEqual({
      names: ["ALPHA"],
    });
    expect(ok(await call("listProjectSecretNames", o, { projectId: second }))).toEqual({ names: ["OTHER"] });
  });
});

// ======================================================================
// 07, Server changes for native clients: /api/v1
// ======================================================================

const v1 = (path: string, init: RequestInit = {}) => {
  const request = new Request(`${APP_ORIGIN}${path}`, init);
  return handleApiV1(request, env, new URL(request.url));
};

describe("/api/v1 (07, Server changes for native clients)", () => {
  it("GET /api/v1/meta needs no auth and returns {protocol, serverVersion, minMacClient, latestMacClient}", async () => {
    const res = await v1("/api/v1/meta");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Row;
    expect(conforms(ApiMeta, meta)).toBe(true);
    expect(Object.keys(meta).sort()).toEqual([
      "latestMacClient",
      "minMacClient",
      "protocol",
      "serverVersion",
    ]);
    expect(meta).toMatchObject({ protocol: 1, latestMacClient: null });
    expect(meta["minMacClient"]).toMatch(/^\d+\.\d+\.\d+$/);
    await env.DATA.put("clients/mac/latest.json", JSON.stringify({ version: "0.4.2" }));
    try {
      const again = (await (await v1("/api/v1/meta")).json()) as Row;
      expect(again["latestMacClient"]).toBe("0.4.2");
    } finally {
      await env.DATA.delete("clients/mac/latest.json");
    }
  });

  it("publishes the signed DMG hash from the same release as latestMacClient", async () => {
    const sha256 = "a".repeat(64);
    await env.DATA.put("clients/mac/latest.json", JSON.stringify({ version: "0.4.2", sha256 }));
    try {
      const meta = await (await v1("/api/v1/meta")).json();
      expect(meta).toMatchObject({ latestMacClient: "0.4.2", latestMacClientSha256: sha256 });
      expect(conforms(ApiMeta, meta)).toBe(true);
    } finally {
      await env.DATA.delete("clients/mac/latest.json");
    }
  });

  it("omits invalid download hashes and rejects malformed release versions", async () => {
    for (const release of [
      { version: "0.4.2", sha256: "invalid" },
      { version: 42, sha256: "a".repeat(64) },
    ]) {
      await env.DATA.put("clients/mac/latest.json", JSON.stringify(release));
      try {
        const meta = (await (await v1("/api/v1/meta")).json()) as Row;
        expect(meta["latestMacClientSha256"]).toBeUndefined();
        expect(meta["latestMacClient"]).toBe(typeof release.version === "string" ? release.version : null);
        expect(conforms(ApiMeta, meta)).toBe(true);
      } finally {
        await env.DATA.delete("clients/mac/latest.json");
      }
    }
  });

  it("POST /api/v1/rpc/<function> accepts a bearer token (AT-24)", async () => {
    const o = await owner();
    const res = await v1("/api/v1/rpc/listProjects", {
      method: "POST",
      headers: { Authorization: `Bearer ${o.token}` },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Row[]).map((p) => p["id"])).toEqual([o.projectId]);
    // An empty body is the empty input.
    const empty = await v1("/api/v1/rpc/listProjects", {
      method: "POST",
      headers: { Authorization: `Bearer ${o.token}` },
    });
    expect(empty.status).toBe(200);
  });

  it("refuses a cookie-only request with 401 UNAUTHENTICATED (AT-24)", async () => {
    const o = await owner();
    const cookie = await sessionCookie(o.token);
    // The same cookie is a valid session for the web wrapper.
    expect(ok(await runFn("listProjects", env, new Headers({ Cookie: cookie }), {}, COOKIE))).toHaveLength(1);
    const res = await v1("/api/v1/rpc/listProjects", {
      method: "POST",
      headers: { Cookie: cookie, Origin: APP_ORIGIN },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorBody).code).toBe("UNAUTHENTICATED");
  });

  it("returns 401 without any credentials and 403 FORBIDDEN for a non-owner", async () => {
    const none = await v1("/api/v1/rpc/listProjects", { method: "POST", body: "{}" });
    expect(none.status).toBe(401);
    const stranger = await seedStranger();
    const res = await v1("/api/v1/rpc/listProjects", {
      method: "POST",
      headers: { Authorization: `Bearer ${stranger.token}` },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).code).toBe("FORBIDDEN");
  });

  it("returns 404 NOT_FOUND for an unknown function", async () => {
    const o = await owner();
    const res = await v1("/api/v1/rpc/dropAllTables", {
      method: "POST",
      headers: { Authorization: `Bearer ${o.token}` },
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).code).toBe("NOT_FOUND");
    const proto = await v1("/api/v1/rpc/constructor", {
      method: "POST",
      headers: { Authorization: `Bearer ${o.token}` },
      body: "{}",
    });
    expect(proto.status).toBe(404);
  });

  it("returns VALIDATION_FAILED for a body that is not JSON or fails the schema", async () => {
    const o = await owner();
    const headers = { Authorization: `Bearer ${o.token}` };
    const notJson = await v1("/api/v1/rpc/listWorkspaces", { method: "POST", headers, body: "{nope" });
    expect(((await notJson.json()) as ErrorBody).code).toBe("VALIDATION_FAILED");
    const bad = await v1("/api/v1/rpc/linkProject", {
      method: "POST",
      headers,
      body: JSON.stringify({ installationId: "x" }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ErrorBody).code).toBe("VALIDATION_FAILED");
  });

  it("runs workspace functions with the same ownership check (07, One handler per function)", async () => {
    const o = await owner();
    const { workspaceId } = await seedWorkspace(o);
    const headers = { Authorization: `Bearer ${o.token}` };
    const mine = await v1("/api/v1/rpc/getWorkspace", {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId }),
    });
    expect(mine.status).toBe(200);
    const detail = await mine.json();
    expect(conforms(WorkspaceDetail, detail)).toBe(true);
    const other = await owner();
    const theirs = await insertWorkspaceRow({
      projectId: other.projectId,
      userId: other.userId,
      slug: "lisbon",
    });
    const res = await v1("/api/v1/rpc/getWorkspace", {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: theirs }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).code).toBe("NOT_FOUND");
  });

  it("carries the function's own error codes in {code, message, detail?}", async () => {
    const o = await owner();
    const res = await v1("/api/v1/rpc/linkProject", {
      method: "POST",
      headers: { Authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ installationId: o.installationId, repoId: o.repoId }),
    });
    expect(res.ok).toBe(false);
    expect(await res.json()).toMatchObject({
      code: "PROJECT_EXISTS",
      message: "This repo is already a project.",
    });
  });
});

// ======================================================================
// 02, Upgrade rules for all three channels; 07 WebSocket auth
// ======================================================================

const upgrade = (path: string, headers: Record<string, string>) => {
  const request = new Request(`${APP_ORIGIN}${path}`, { headers: { Upgrade: "websocket", ...headers } });
  return handleChannel(request, env, new URL(request.url));
};

const accept = (res: Response) => {
  const ws = res.webSocket!;
  const messages: Row[] = [];
  const state: { closed: { code: number; reason: string } | null } = { closed: null };
  ws.addEventListener("message", (e) => {
    messages.push(JSON.parse(String(e.data)) as Row);
  });
  ws.addEventListener("close", (e) => {
    state.closed = { code: e.code, reason: e.reason };
  });
  ws.accept();
  return { ws, messages, state };
};

describe("channel upgrades (02, Upgrade rules for all three channels; 07, WebSocket auth)", () => {
  it("returns 403 for a wrong Origin, with or without a session", async () => {
    const o = await owner();
    expect((await upgrade("/api/ws/hub", { Origin: "https://evil.example" }))?.status).toBe(403);
    expect(
      (await upgrade("/api/ws/hub", { Origin: "https://evil.example", Cookie: await sessionCookie(o.token) }))
        ?.status,
    ).toBe(403);
    expect(
      (await upgrade("/api/ws/hub", { Origin: "https://evil.example", Authorization: `Bearer ${o.token}` }))
        ?.status,
    ).toBe(403);
  });

  it("returns 403 with no Origin and no bearer token", async () => {
    const o = await owner();
    expect((await upgrade("/api/ws/hub", {}))?.status).toBe(403);
    expect((await upgrade("/api/ws/hub", { Cookie: await sessionCookie(o.token) }))?.status).toBe(403);
  });

  it("returns 401 for a browser upgrade without a session", async () => {
    expect((await upgrade("/api/ws/hub", { Origin: APP_ORIGIN }))?.status).toBe(401);
  });

  it("returns 403 for a non-owner", async () => {
    const stranger = await seedStranger();
    expect((await upgrade("/api/ws/hub", { Authorization: `Bearer ${stranger.token}` }))?.status).toBe(403);
  });

  it("accepts a bearer upgrade with no Origin on the hub channel (AT-25)", async () => {
    const o = await owner();
    const res = (await upgrade("/api/ws/hub", { Authorization: `Bearer ${o.token}` }))!;
    expect(res.status).toBe(101);
    const sock = accept(res);
    await waitFor(() => sock.messages.length > 0, 5000, "hub hello");
    expect(sock.messages[0]).toMatchObject({ type: "hello", v: 1 });
    sock.ws.close(1000);
  });

  it("accepts a browser upgrade with the cookie and Origin https://<APP_HOST>", async () => {
    const o = await owner();
    const res = (await upgrade("/api/ws/hub", { Origin: APP_ORIGIN, Cookie: await sessionCookie(o.token) }))!;
    expect(res.status).toBe(101);
    accept(res).ws.close(1000);
  });

  it("accepts a bearer upgrade on the workspace channel and sends hello (AT-25)", async () => {
    const o = await owner();
    const { workspaceId } = await seedWorkspace(o);
    const res = (await upgrade(`/api/ws/workspace/${workspaceId}?sinceRev=0`, {
      Authorization: `Bearer ${o.token}`,
    }))!;
    expect(res.status).toBe(101);
    const sock = accept(res);
    await waitFor(() => sock.messages.length > 0, 5000, "workspace hello");
    expect(sock.messages[0]).toMatchObject({ type: "hello", v: 1 });
    expect(sock.messages[0]!["workspace"]["id"]).toBe(workspaceId);
    sock.ws.close(1000);
  });

  it("drops client x-tempo-* headers, so a forged Browser Run header still opens the channel", async () => {
    const o = await owner();
    const { workspaceId } = await seedWorkspace(o);
    const res = (await upgrade(`/api/ws/workspace/${workspaceId}?sinceRev=0`, {
      Authorization: `Bearer ${o.token}`,
      "x-tempo-browser-app": "3000",
      "x-tempo-browser-cdp": "1",
    }))!;
    expect(res.status).toBe(101);
    const sock = accept(res);
    await waitFor(() => sock.messages.length > 0, 5000, "workspace hello");
    expect(sock.messages[0]).toMatchObject({ type: "hello", v: 1 });
    sock.ws.close(1000);
  });

  it("upgrades, then closes with 4404 for a workspace the user does not own", async () => {
    const o = await owner();
    const other = await owner();
    const theirs = await insertWorkspaceRow({
      projectId: other.projectId,
      userId: other.userId,
      slug: "lisbon",
    });
    for (const path of [
      `/api/ws/workspace/${theirs}`,
      `/api/ws/terminal/${theirs}/t1`,
      `/api/ws/workspace/${newId()}`,
    ]) {
      const res = (await upgrade(path, { Authorization: `Bearer ${o.token}` }))!;
      expect(res.status, path).toBe(101);
      const sock = accept(res);
      await waitFor(() => sock.state.closed !== null, 5000, "close");
      expect(sock.state.closed!.code).toBe(CloseCode.workspaceNotFound);
      expect(CloseCode.workspaceNotFound).toBe(4404);
    }
  });

  it("returns 404 for a terminal id that does not match ^t[1-9]$", async () => {
    const o = await owner();
    const { workspaceId } = await seedWorkspace(o);
    for (const id of ["t0", "t10", "x1", "T1"]) {
      expect(
        (await upgrade(`/api/ws/terminal/${workspaceId}/${id}`, { Authorization: `Bearer ${o.token}` }))
          ?.status,
        id,
      ).toBe(404);
    }
  });
});

// ======================================================================
// 02, Attachments: POST /api/workspaces/<workspaceId>/attachments
// ======================================================================

const postAttachment = (workspaceId: string, form: FormData, headers: Record<string, string>) =>
  handleAttachment(
    new Request(`${APP_ORIGIN}/api/workspaces/${workspaceId}/attachments`, {
      method: "POST",
      headers,
      body: form,
    }),
    env,
    workspaceId,
  );

const formWith = (...files: File[]) => {
  const form = new FormData();
  for (const f of files) form.append("file", f);
  return form;
};

describe("attachments (02, Sessions and turns: attachments route)", () => {
  it("stores one file at attachments/<workspaceId>/<attachmentId>/<file name> and returns {attachmentId, name, mime, size}", async () => {
    const o = await owner();
    const { workspaceId, stub } = await seedWorkspace(o);
    const res = await postAttachment(
      workspaceId,
      formWith(new File(["hello world"], "notes.txt", { type: "text/plain" })),
      {
        Authorization: `Bearer ${o.token}`,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Row;
    expect(body).toEqual({
      attachmentId: expect.stringMatching(ULID),
      name: "notes.txt",
      mime: "text/plain",
      size: 11,
    });
    const key = `attachments/${workspaceId}/${body["attachmentId"]}/notes.txt`;
    const obj = await env.DATA.get(key);
    expect(await obj?.text()).toBe("hello world");
    expect(obj?.httpMetadata?.contentType).toBe("text/plain");
    const rows = await doRows(stub, "SELECT * FROM attachments WHERE id = ?", body["attachmentId"]);
    expect(rows[0]).toMatchObject({ name: "notes.txt", mime: "text/plain", size_bytes: 11, r2_key: key });
  });

  it("refuses a cookie upload without an Origin header (05, CSRF) and one from another origin", async () => {
    const o = await owner();
    const { workspaceId } = await seedWorkspace(o);
    const cookie = await sessionCookie(o.token);
    const file = () => formWith(new File(["x"], "x.txt", { type: "text/plain" }));
    const bare = await postAttachment(workspaceId, file(), { Cookie: cookie });
    expect(((await bare.json()) as ErrorBody).code).toBe("FORBIDDEN");
    const foreign = await postAttachment(workspaceId, file(), {
      Cookie: cookie,
      Origin: "https://evil.test",
    });
    expect(((await foreign.json()) as ErrorBody).code).toBe("FORBIDDEN");
    const same = await postAttachment(workspaceId, file(), { Cookie: cookie, Origin: APP_ORIGIN });
    expect(same.status).toBe(200);
  });

  it("returns FILE_TOO_LARGE for a file over 10 MiB and stores nothing", async () => {
    const o = await owner();
    const { workspaceId } = await seedWorkspace(o);
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.bin", {
      type: "application/octet-stream",
    });
    const res = await postAttachment(workspaceId, formWith(big), { Authorization: `Bearer ${o.token}` });
    expect(((await res.json()) as ErrorBody).code).toBe("FILE_TOO_LARGE");
    expect((await env.DATA.list({ prefix: `attachments/${workspaceId}/` })).objects).toHaveLength(0);
  });

  it("returns VALIDATION_FAILED unless exactly one file is sent", async () => {
    const o = await owner();
    const { workspaceId } = await seedWorkspace(o);
    const two = await postAttachment(
      workspaceId,
      formWith(new File(["a"], "a.txt"), new File(["b"], "b.txt")),
      {
        Authorization: `Bearer ${o.token}`,
      },
    );
    expect(((await two.json()) as ErrorBody).code).toBe("VALIDATION_FAILED");
    const none = new FormData();
    none.append("text", "not a file");
    const zero = await postAttachment(workspaceId, none, { Authorization: `Bearer ${o.token}` });
    expect(((await zero.json()) as ErrorBody).code).toBe("VALIDATION_FAILED");
  });

  it("refuses unauthenticated, wrong-Origin, non-owned and archived workspaces", async () => {
    const o = await owner();
    const { workspaceId } = await seedWorkspace(o);
    const file = () => formWith(new File(["x"], "x.txt"));
    const anon = await postAttachment(workspaceId, file(), {});
    expect(anon.status).toBe(401);
    const origin = await postAttachment(workspaceId, file(), {
      Authorization: `Bearer ${o.token}`,
      Origin: "https://evil.example",
    });
    expect(((await origin.json()) as ErrorBody).code).toBe("FORBIDDEN");
    const other = await owner();
    const theirs = await insertWorkspaceRow({
      projectId: other.projectId,
      userId: other.userId,
      slug: "lisbon",
    });
    const notMine = await postAttachment(theirs, file(), { Authorization: `Bearer ${o.token}` });
    expect(((await notMine.json()) as ErrorBody).code).toBe("NOT_FOUND");
    const archived = await insertWorkspaceRow({
      projectId: o.projectId,
      userId: o.userId,
      slug: "porto",
      archivedAt: Date.now(),
    });
    const res = await postAttachment(archived, file(), { Authorization: `Bearer ${o.token}` });
    expect(((await res.json()) as ErrorBody).code).toBe("WORKSPACE_ARCHIVED");
    expect((await env.DATA.list({ prefix: `attachments/${workspaceId}/` })).objects).toHaveLength(0);
  });
});

// ======================================================================
// 05, Preview access; 01, Preview request path
// ======================================================================

const previewGet = (host: string, path = "/", headers: Record<string, string> = {}) => {
  const request = new Request(`https://${host}${path}`, { headers });
  return handlePreview(request, env, new URL(request.url));
};

describe("preview access (05, Preview access)", () => {
  const PAGE = "This preview opens only from Tempo.";
  const isPreview404 = async (res: Response, label = "") => {
    expect(res.status, label).toBe(404);
    expect(await res.text(), label).toContain(PAGE);
    expect(res.headers.get("Referrer-Policy"), label).toBe("no-referrer");
    expect(res.headers.get("X-Robots-Tag"), label).toBe("noindex, nofollow");
  };
  const addPort = (stub: DurableObjectStub<WorkspaceDO>, port: number) =>
    doRows(stub, "INSERT INTO ports (port, first_seen_at) VALUES (?, 0)", port);
  const enter = async (entryUrl: string) => {
    const u = new URL(entryUrl);
    return previewGet(u.host, `${u.pathname}${u.search}`);
  };

  it("returns the preview 404 page for a first label that does not match the pattern", async () => {
    const id = newId();
    for (const host of [
      "previews.test.previews.test",
      `80-${id}.previews.test`,
      `3000-${id.toUpperCase().slice(0, 25)}I.previews.test`,
      `3000-${id}-k3j9x2m4q8w7e5r1.previews.test`,
      `3000-${id}-x.previews.test`,
      "nope.previews.test",
    ]) {
      await isPreview404(await previewGet(host), host);
    }
  });

  it("openPreview returns a one-time entry link for a detected port and keeps only the code's SHA-256", async () => {
    const o = await owner();
    const { workspaceId, stub } = await seedWorkspace(o);
    await addPort(stub, 3000);
    const before = Date.now();
    const { url } = ok(await call("openPreview", o, { workspaceId, port: 3000 }));
    // 05 Entry link: https://<P>-<workspaceId lowercase>.<PREVIEW_DOMAIN>/__tempo/enter?code=<code>
    const m = new RegExp(
      `^https://3000-${workspaceId}\\.previews\\.test/__tempo/enter\\?code=([a-z0-9]{32})$`,
    ).exec(url);
    expect(m, url).not.toBeNull();
    const code = m![1]!;
    const stored = await doRows(stub, "SELECT * FROM preview_codes");
    expect(stored).toHaveLength(1);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(stored[0]).toEqual({ code_hash: hex, port: 3000, expires_at: expect.any(Number) });
    expect(stored[0]!["expires_at"]).toBeGreaterThanOrEqual(before + 60_000);
    expect(stored[0]!["expires_at"]).toBeLessThanOrEqual(Date.now() + 60_000);
    const second = ok(await call("openPreview", o, { workspaceId, port: 3000 })).url;
    expect(second).not.toBe(url);
  });

  it("openPreview returns NOT_FOUND for a port that is not detected, and only the owner may call it", async () => {
    const o = await owner();
    const { workspaceId, stub } = await seedWorkspace(o);
    await addPort(stub, 3000);
    expect(codeOf(await call("openPreview", o, { workspaceId, port: 5173 }))).toBe("NOT_FOUND");
    expect(codeOf(await call("openPreview", o, { workspaceId, port: 7070 }))).toBe("NOT_FOUND");
    expect(codeOf(await call("openPreview", null, { workspaceId, port: 3000 }))).toBe("UNAUTHENTICATED");
    expect(codeOf(await call("openPreview", await seedStranger(), { workspaceId, port: 3000 }))).toBe(
      "FORBIDDEN",
    );
    expect(await doRows(stub, "SELECT * FROM preview_codes")).toHaveLength(0);
  });

  it("the same 404 page for an unknown workspace, a bad code and a missing or bad cookie", async () => {
    const o = await owner();
    const { workspaceId, stub } = await seedWorkspace(o);
    await addPort(stub, 3000);
    const host = `3000-${workspaceId}.previews.test`;
    const unknown = `3000-${newId()}.previews.test`;
    const cookie = {
      Cookie: `__Host-tempo_preview=${Math.floor(Date.now() / 1000) + 3600}.${"A".repeat(43)}`,
    };
    for (const [label, res] of [
      ["unknown workspace", await previewGet(unknown)],
      ["unknown workspace with a cookie", await previewGet(unknown, "/", cookie)],
      ["unknown workspace, enter", await previewGet(unknown, `/__tempo/enter?code=${"a".repeat(32)}`)],
      ["missing cookie", await previewGet(host)],
      ["bad cookie", await previewGet(host, "/", cookie)],
      ["bad code", await previewGet(host, `/__tempo/enter?code=${"a".repeat(32)}`)],
      ["short code", await previewGet(host, "/__tempo/enter?code=abc")],
      ["no code", await previewGet(host, "/__tempo/enter")],
    ] as const) {
      await isPreview404(res, label);
    }
  });

  it("serves the waking page after entering while the container is down, with the privacy headers", async () => {
    // A workspace from createWorkspace has no container in tests, so it never comes up.
    const o = await owner();
    const workspaceId = String(
      ok(
        await call("createWorkspace", o, {
          projectId: o.projectId,
          source: { kind: "new", baseBranch: "main" },
        }),
      )["id"],
    );
    const stub = env.WORKSPACE.getByName(workspaceId);
    await addPort(stub, 3000);
    const entered = await enter(ok(await call("openPreview", o, { workspaceId, port: 3000 })).url);
    expect(entered.status).toBe(303);
    const value = /^__Host-tempo_preview=([^;]+);/.exec(entered.headers.get("Set-Cookie") ?? "")![1]!;
    const host = `3000-${workspaceId}.PREVIEWS.test`;
    const html = await previewGet(host, "/", {
      Accept: "text/html",
      Cookie: `__Host-tempo_preview=${value}`,
    });
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("Waking workspace");
    expect(html.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(html.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const api = await previewGet(host, "/api/data", {
      Accept: "application/json",
      Cookie: `__Host-tempo_preview=${value}`,
    });
    expect(api.status).toBe(503);
    expect(api.headers.get("Retry-After")).toBe("5");
    expect(api.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(api.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });
});

// ======================================================================
// 01, Credentials and egress: TempoOutbound; 05, Egress control
// ======================================================================

const outbound = (workspaceId: string, userId: string) =>
  (
    exports as unknown as {
      TempoOutbound: (o: { props: { workspaceId: string; userId: string } }) => Fetcher;
    }
  ).TempoOutbound({
    props: { workspaceId, userId },
  });

const egressRows = (stub: DurableObjectStub<WorkspaceDO>) =>
  doRows(stub, "SELECT * FROM egress_log ORDER BY id");

/** Runs the create op until the workspace is ready (alarms may also fire on their own). */
const driveReady = async (stub: DurableObjectStub<WorkspaceDO>): Promise<void> => {
  for (let i = 0; i < 50; i++) {
    const d = await stub.getWorkspace({});
    if (d.ok && ["ready", "working"].includes(String((d.value as Row)["state"]))) return;
    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("workspace did not become ready");
};

describe("TempoOutbound (01, Credentials and egress; 05, Egress control)", () => {
  it("rule 2: adds Basic x-access-token auth for the project's repo on github.com and logs the request", async () => {
    const o = await owner();
    const { workspaceId, stub } = await seedWorkspace(o);
    const before = gh.upstream.length;
    const res = await outbound(workspaceId, o.userId).fetch(
      "https://github.com/ACME/app.git/info/refs?service=git-upload-pack",
      {
        headers: { "User-Agent": "git/2.45" },
      },
    );
    expect(res.status).toBe(200);
    const sent = gh.upstream.slice(before).find((r) => r.url.hostname === "github.com");
    const basic = /^Basic (.+)$/.exec(sent?.headers.get("Authorization") ?? "");
    expect(basic).not.toBeNull();
    const [user, token] = atob(basic![1]!).split(":");
    expect(user).toBe("x-access-token");
    const minted = gh.tokens.find((t) => t.token === token);
    expect(minted?.installationId).toBe(o.installationId);
    // 01: "The token is minted with repository_ids: [<repo id>]" and the six permissions.
    expect(minted!.body).toEqual({
      repository_ids: [o.repoId],
      permissions: {
        contents: "write",
        pull_requests: "write",
        metadata: "read",
        checks: "read",
        actions: "read",
        issues: "read",
      },
    });
    // 01: log {ts, method, host, path, status, ms, rule}; path without the query string.
    await waitFor(async () => (await egressRows(stub)).length > 0, 5000, "egress_log row");
    const [row] = await egressRows(stub);
    expect(row).toMatchObject({
      method: "GET",
      host: "github.com",
      path: "/ACME/app.git/info/refs",
      status: 200,
      rule: 2,
    });
    expect(typeof row!["ms"]).toBe("number");
  });

  it("rule 3: adds Bearer <token> for api.github.com", async () => {
    const o = await owner();
    const { workspaceId } = await seedWorkspace(o);
    const before = gh.requests.length;
    const res = await outbound(workspaceId, o.userId).fetch("https://api.github.com/repos/acme/app/issues");
    expect(res.status).toBe(200);
    const sent = gh.requests.slice(before).find((r) => r.url.pathname === "/repos/acme/app/issues");
    expect(sent?.headers.get("Authorization")).toMatch(/^Bearer ghs_/);
  });

  it("does not add GitHub credentials for another repo on github.com", async () => {
    const o = await owner();
    const { workspaceId } = await seedWorkspace(o);
    const before = gh.upstream.length;
    await outbound(workspaceId, o.userId).fetch("https://github.com/other/repo.git/info/refs");
    const sent = gh.upstream.slice(before).find((r) => r.url.pathname === "/other/repo.git/info/refs");
    expect(sent).toBeDefined();
    expect(sent!.headers.get("Authorization")).toBeNull();
  });

  it("rule 4: swaps the placeholder for the real OpenRouter key", async () => {
    const o = await owner();
    await seedCredentials(o.userId);
    const { workspaceId } = await seedWorkspace(o);
    const before = gh.upstream.length;
    const res = await outbound(workspaceId, o.userId).fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${PLACEHOLDER}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "x" }),
    });
    expect(res.status).toBe(200);
    const sent = gh.upstream.slice(before).find((r) => r.url.hostname === "openrouter.ai");
    expect(sent?.headers.get("Authorization")).toBe("Bearer sk-or-test");
    expect(JSON.stringify([...sent!.headers])).not.toContain(PLACEHOLDER);
  });

  it("rule 0: returns 403 for APP_HOST and never forwards it; logs rule 0", async () => {
    const o = await owner();
    const { workspaceId, stub } = await seedWorkspace(o);
    const before = gh.upstream.length;
    const res = await outbound(workspaceId, o.userId).fetch("https://tempo.test/api/v1/rpc/listProjects", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(gh.upstream.slice(before).some((r) => r.url.hostname === "tempo.test")).toBe(false);
    await waitFor(
      async () => (await egressRows(stub)).some((r) => r["host"] === "tempo.test"),
      5000,
      "egress_log row",
    );
    expect((await egressRows(stub)).find((r) => r["host"] === "tempo.test")).toMatchObject({
      status: 403,
      rule: 0,
      method: "POST",
    });
  });

  it("rule 7: refuses a request that still carries the placeholder", async () => {
    const o = await owner();
    const { workspaceId } = await seedWorkspace(o);
    const before = gh.upstream.length;
    const res = await outbound(workspaceId, o.userId).fetch("https://evil.example/collect", {
      headers: { "X-Key": PLACEHOLDER },
    });
    expect(res.status).toBe(403);
    expect(gh.upstream.slice(before).some((r) => r.url.hostname === "evil.example")).toBe(false);
  });

  it("rule 1: an http: request to github.com gets no credentials", async () => {
    const o = await owner();
    const { workspaceId } = await seedWorkspace(o);
    const before = gh.upstream.length;
    await outbound(workspaceId, o.userId).fetch("http://github.com/acme/app.git/info/refs");
    const sent = gh.upstream.slice(before).find((r) => r.url.hostname === "github.com");
    expect(sent).toBeDefined();
    expect(sent!.headers.get("Authorization")).toBeNull();
  });

  it("allowlist policy: blocks other hosts with 403 'tempo: egress blocked for <host>' and logs the row (AT-20)", async () => {
    const environment = { egress_policy: "allowlist", egress_allowlist: ["*.example.com"] } as const;
    const o = await owner({ settingsJson: JSON.stringify({ environment }) });
    const { workspaceId, stub, tempod } = await seedWorkspace(o);
    // The fake tempod's settings.read ignores overrides; answer with the allowlist and re-read.
    await driveReady(stub);
    tempod.on("settings.read", () => ({
      effective: { ...DEFAULT_EFFECTIVE, environment: { ...DEFAULT_EFFECTIVE.environment, ...environment } },
      warnings: [],
      errors: [],
      sources: {},
    }));
    await stub.refreshSettings();
    expect(await stub.getEgressConfig()).toMatchObject({
      owner: "acme",
      repo: "app",
      policy: "allowlist",
      allowlist: ["*.example.com"],
    });
    const out = outbound(workspaceId, o.userId);
    const blocked = await out.fetch("https://example.com/");
    expect(blocked.status).toBe(403);
    expect(await blocked.text()).toBe("tempo: egress blocked for example.com");
    expect((await out.fetch("https://cdn.example.com/lib.js")).status).toBe(200);
    expect((await out.fetch("https://registry.npmjs.org/react")).status).toBe(200);
    await waitFor(async () => (await egressRows(stub)).length >= 3, 5000, "egress_log rows");
    const rows = await egressRows(stub);
    expect(rows.find((r) => r["host"] === "example.com")).toMatchObject({ status: 403, rule: 10 });
    expect(rows.find((r) => r["host"] === "cdn.example.com")).toMatchObject({ status: 200, rule: 9 });
  });
});

// ======================================================================
// 05, GitHub App setup (manifest flow). Runs last: it removes and recreates the App config.
// ======================================================================

const setup = (pathAndQuery: string, init: RequestInit = {}) => {
  const request = new Request(`${APP_ORIGIN}${pathAndQuery}`, init);
  return handleSetup(request, env, new URL(request.url));
};

const unescapeHtml = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

describe("GitHub App setup (05, Deployment and configuration: GitHub App setup)", () => {
  it("returns 404 once the GitHub App is configured, even with the token", async () => {
    const res = await setup(`/setup/github?token=${env.TEMPO_SETUP_TOKEN}`);
    expect(res.status).toBe(404);
    const status = (await (await handleSetupStatus(env)).json()) as Row;
    expect(status).toEqual({
      configured: true,
      installUrl: `https://github.com/apps/${APP.slug}/installations/new`,
    });
  });

  describe("while no App is configured", () => {
    beforeAll(removeAppConfig);
    afterAll(async () => {
      gh.appId = APP.appId;
      await putAppConfig();
    });

    it("returns 404 without the token or with a wrong one", async () => {
      expect((await setup("/setup/github")).status).toBe(404);
      expect((await setup("/setup/github?token=wrong")).status).toBe(404);
      expect((await setup(`/setup/github?token=${env.TEMPO_SETUP_TOKEN}x`)).status).toBe(404);
      const status = (await (await handleSetupStatus(env)).json()) as Row;
      expect(status).toEqual({ configured: false, installUrl: null });
    });

    it("server functions that need the App fail with GITHUB_API_ERROR", async () => {
      const o = await owner();
      expect(codeOf(await call("listInstallations", o))).toBe("GITHUB_API_ERROR");
    });

    it("serves the manifest form with the exact fields from 05", async () => {
      const res = await setup(`/setup/github?token=${env.TEMPO_SETUP_TOKEN}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`action="https://github.com/settings/apps/new?state=${env.TEMPO_SETUP_TOKEN}"`);
      expect(html).toContain("https://github.com/organizations/");
      const m = /name="manifest" value="([^"]+)"/.exec(html);
      expect(m).not.toBeNull();
      const manifest = JSON.parse(unescapeHtml(m![1]!)) as Row;
      expect(manifest).toMatchObject({
        name: "Tempo (tempo.test)",
        url: "https://tempo.test",
        callback_urls: ["https://tempo.test/api/auth/callback/github"],
        redirect_url: "https://tempo.test/setup/github/callback",
        setup_url: "https://tempo.test/setup/github/installed",
        public: false,
        hook_attributes: { active: false },
      });
      expect(manifest["default_permissions"]).toEqual({
        contents: "write",
        pull_requests: "write",
        metadata: "read",
        checks: "read",
        actions: "read",
        issues: "read",
      });
    });

    it("callback without a code returns 400", async () => {
      expect((await setup(`/setup/github/callback?state=${env.TEMPO_SETUP_TOKEN}`)).status).toBe(400);
    });

    it("callback exchanges the code, stores the App in the system CredentialDO and links to the install page", async () => {
      gh.conversion = {
        id: 654_321,
        slug: "tempo-tempo-test",
        pem: gh.privatePem,
        client_id: "Iv1.fromgithub",
        client_secret: "from-github-secret",
      };
      const before = gh.requests.length;
      const res = await setup(`/setup/github/callback?code=abc123&state=${env.TEMPO_SETUP_TOKEN}`);
      expect(res.status).toBe(200);
      const conv = gh.requests
        .slice(before)
        .find((r) => r.url.pathname === "/app-manifests/abc123/conversions");
      expect(conv?.method).toBe("POST");
      const html = await res.text();
      expect(html).toContain("https://github.com/apps/tempo-tempo-test/installations/new");
      expect(html).not.toContain("from-github-secret");
      const stored = await env.CREDENTIALS.getByName(SYSTEM_CREDENTIALS).getGithubAppConfig();
      expect(stored).toEqual({
        appId: "654321",
        slug: "tempo-tempo-test",
        privateKey: gh.privatePem,
        clientId: "Iv1.fromgithub",
        clientSecret: "from-github-secret",
      });
      // After setup the pages return 404.
      expect((await setup(`/setup/github?token=${env.TEMPO_SETUP_TOKEN}`)).status).toBe(404);
      // The stored App mints tokens.
      gh.appId = "654321";
      const o = await owner();
      gh.installations = [
        { id: o.installationId, account: { login: "acme", type: "Organization" }, suspended_at: null },
      ];
      expect(ok(await call("listInstallations", o))).toEqual([
        { installationId: o.installationId, accountLogin: "acme", accountType: "Organization" },
      ]);
      gh.installations = [];
      gh.conversion = null;
    });
  });

  it("GitHub's setup_url redirects to the app", async () => {
    const res = await setup("/setup/github/installed?installation_id=1&setup_action=install");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://tempo.test/");
  });
});

describe("authenticated attachment reads", () => {
  it("serves owner image bytes after reload and while archived, with private safety headers", async () => {
    const o = await owner();
    const { workspaceId, stub } = await seedWorkspace(o);
    const upload = await postAttachment(
      workspaceId,
      formWith(new File(["png bytes"], "shot.png", { type: "image/png" })),
      { Authorization: `Bearer ${o.token}` },
    );
    const a = (await upload.json()) as Row;
    await runInDurableObject(stub, (_i: WorkspaceDO, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE workspace SET archived_at = 1, state = 'archived'");
    });
    await env.DB.prepare("UPDATE workspaces SET archived_at = 1 WHERE id = ?").bind(workspaceId).run();
    const url = `${APP_ORIGIN}/api/workspaces/${workspaceId}/attachments/${a["attachmentId"]}`;
    const read = (headers: HeadersInit) =>
      handleAttachmentRead(new Request(url, { headers }), env, workspaceId, a["attachmentId"]);
    const response = await read({ Cookie: await sessionCookie(o.token) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("png bytes");
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await read({})).status).toBe(401);
    expect((await read({ Authorization: `Bearer ${o.token}`, Origin: "https://evil.test" })).status).toBe(
      403,
    );
    expect(
      (
        await handleAttachmentRead(
          new Request(url, { headers: { Authorization: `Bearer ${o.token}` } }),
          env,
          workspaceId,
          newId(),
        )
      ).status,
    ).toBe(404);
    const other = await owner();
    expect((await read({ Authorization: `Bearer ${other.token}` })).status).toBe(404);
  });

  it("forces active content to download and rejects inconsistent or missing objects", async () => {
    const o = await owner();
    const { workspaceId, stub } = await seedWorkspace(o);
    const upload = await postAttachment(
      workspaceId,
      formWith(new File(["<svg/>"], "shot.svg", { type: "image/svg+xml" })),
      { Authorization: `Bearer ${o.token}` },
    );
    const a = (await upload.json()) as Row;
    const read = () =>
      handleAttachmentRead(
        new Request(`${APP_ORIGIN}/api/workspaces/${workspaceId}/attachments/${a["attachmentId"]}`, {
          headers: { Authorization: `Bearer ${o.token}` },
        }),
        env,
        workspaceId,
        a["attachmentId"],
      );
    const response = await read();
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Disposition")).toBe("attachment");
    await runInDurableObject(stub, (_i: WorkspaceDO, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE attachments SET size_bytes = 9 WHERE id = ?", a["attachmentId"]);
    });
    expect((await read()).status).toBe(413);
    await env.DATA.delete(`attachments/${workspaceId}/${a["attachmentId"]}/shot.svg`);
    expect((await read()).status).toBe(404);
  });
});
