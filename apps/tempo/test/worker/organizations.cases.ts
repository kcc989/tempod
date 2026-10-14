import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newId, type ProjectRole } from "@tempo/protocol";
import { assertOrganizationSlug, usernameFor, type AuthNamespaces } from "../../src/auth/options.ts";
import type { Env } from "../../src/env.ts";
import { createRepository } from "../../src/server/handlers/repositories.ts";
import { listProjectSecretNames, setProjectSecret } from "../../src/server/handlers/credentials.ts";
import { listProjects } from "../../src/server/handlers/projects.ts";
import {
  exploreProjects,
  getProject,
  listProjectMembers,
  listStarredProjects,
  putProjectMember,
  setProjectVisibility,
  starProject,
  unstarProject,
} from "../../src/server/handlers/social.ts";
import { createWorkspace, viaWorkspace } from "../../src/server/handlers/workspaces.ts";
import { runFn, type HandlerCtx } from "../../src/server/run.ts";
import { artifactMetadata, fakeArtifactRepo, fakeArtifacts } from "./artifacts-fake.ts";
import { seedProject, seedWorkspace } from "./fakes.ts";

const ANONYMOUS = { allowCookie: true, allowBearer: true };

/** A signed-in user with a username (11, Identity). */
const seedUser = async (username: string): Promise<HandlerCtx> => {
  const id = `user-${newId()}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, username, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)",
  )
    .bind(id, username, `${id}@example.com`, username, now, now)
    .run();

  return { env, user: { id, name: username, email: `${id}@example.com`, image: null } };
};

/** The seeded project's owner, named so its namespace resolves. */
const seedOwner = async (username: string) => {
  const seeded = await seedProject();
  await env.DB.prepare("UPDATE user SET username = ? WHERE id = ?").bind(username, seeded.userId).run();

  const ctx: HandlerCtx = {
    env,
    user: { id: seeded.userId, name: "Owner", email: "o@example.com", image: null },
  };

  return { seeded, ctx };
};

const addMember = (projectId: string, userId: string, role: ProjectRole) =>
  env.DB.prepare(
    "INSERT INTO project_members (project_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1) ON CONFLICT DO UPDATE SET role = excluded.role",
  )
    .bind(projectId, userId, role)
    .run();

const anonymously = (name: "getProject", input: { namespace: string; slug: string }) =>
  runFn(name, env, new Headers(), input, ANONYMOUS);

const unique = () => newId().slice(-8);

describe("organizations, project roles and stars (11)", () => {
  it("shows public projects to anonymous callers, hides private ones, and gates changes by role", async () => {
    const name = `owner-${unique()}`;
    const { seeded, ctx: owner } = await seedOwner(name);
    const reader = await seedUser(`reader-${unique()}`);
    const stranger = await seedUser(`stranger-${unique()}`);
    const project = { projectId: seeded.projectId };

    expect(await anonymously("getProject", { namespace: name, slug: "app" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    await expect(setProjectVisibility(stranger, { ...project, visibility: "public" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await setProjectVisibility(owner, { ...project, visibility: "public" })).toMatchObject({
      namespace: name,
      slug: "app",
      visibility: "public",
      role: "admin",
    });
    expect(await anonymously("getProject", { namespace: name.toUpperCase(), slug: "APP" })).toMatchObject({
      ok: true,
      value: { id: seeded.projectId, role: "read", starred: false, stars: 0 },
    });

    // A public grant reads, but it is not a membership role: member lists and changes are refused.
    await expect(listProjectMembers(stranger, project)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await addMember(seeded.projectId, reader.user.id, "read");
    expect((await listProjectMembers(reader, project)).map((m) => m.role)).toEqual(["read"]);
    await expect(
      putProjectMember(reader, { ...project, username: stranger.user.name, role: "write" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      putProjectMember(owner, { ...project, username: name, role: "write" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(
      await putProjectMember(owner, { ...project, username: stranger.user.name, role: "write" }),
    ).toMatchObject({ userId: stranger.user.id, role: "write" });
    expect((await listProjects(stranger)).map((p) => p.id)).toEqual([seeded.projectId]);
    expect(await listProjects(reader)).toEqual([]);
  });

  it("gives organization roles and refuses agent work once a member loses write", async () => {
    const { seeded, ctx: owner } = await seedOwner(`holder-${unique()}`);
    const orgAdmin = await seedUser(`admin-${unique()}`);
    const orgMember = await seedUser(`member-${unique()}`);
    const orgId = newId();
    const slug = `org-${unique()}`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO organization (id, name, slug, created_at) VALUES (?, 'Org', ?, 1)").bind(
        orgId,
        slug,
      ),
      env.DB.prepare(
        "INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'admin', 1)",
      ).bind(newId(), orgId, orgAdmin.user.id),
      env.DB.prepare(
        "INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', 1)",
      ).bind(newId(), orgId, orgMember.user.id),
      env.DB.prepare("UPDATE projects SET organization_id = ? WHERE id = ?").bind(orgId, seeded.projectId),
    ]);
    const project = { projectId: seeded.projectId };

    // The holder of an organization project has no personal admin role on it.
    await expect(setProjectVisibility(owner, { ...project, visibility: "public" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await setProjectVisibility(orgAdmin, { ...project, visibility: "private" })).toMatchObject({
      namespace: slug,
      role: "admin",
    });
    expect(await listProjectMembers(orgMember, project)).toEqual([]);
    expect(await listProjects(orgMember)).toEqual([]);
    await expect(
      createWorkspace(orgMember, { ...project, source: { kind: "new", baseBranch: "main" } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await addMember(seeded.projectId, orgMember.user.id, "write");
    const { workspaceId } = await seedWorkspace({ ...seeded, userId: orgMember.user.id });
    await addMember(seeded.projectId, orgMember.user.id, "read");
    await expect(
      viaWorkspace("sendPrompt")(orgMember, {
        workspaceId,
        sessionId: "s",
        text: "hi",
        mentions: [],
        attachmentIds: [],
        reviewCommentIds: [],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await viaWorkspace("getWorkspace")(orgMember, { workspaceId })).toMatchObject({ id: workspaceId });
    await expect(viaWorkspace("getWorkspace")(orgAdmin, { workspaceId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("keeps Artifacts names per owner and stores project secrets with the project holder", async () => {
    const repos = new Map<string, ArtifactsRepoInfo>();

    const artifacts = fakeArtifacts(
      async (name) => {
        const info = repos.get(name);

        if (!info) throw Object.assign(new Error("missing"), { code: "NOT_FOUND" });

        return fakeArtifactRepo(info, { revokeToken: async () => true });
      },
      {
        create: async (name) => {
          if (repos.has(name)) throw Object.assign(new Error("exists"), { code: "ALREADY_EXISTS" });
          const info = artifactMetadata(name);
          repos.set(name, info);

          return { ...info, token: "art_v1_initial" };
        },
      },
    );

    const testEnv: Env = { ...env, ARTIFACTS: artifacts };
    const a = await seedUser(`a-${unique()}`);
    const b = await seedUser(`b-${unique()}`);
    const first = await createRepository({ ...a, env: testEnv }, { name: "app" });
    const second = await createRepository({ ...b, env: testEnv }, { name: "app" });
    expect(second.id).not.toBe(first.id);
    expect(second.artifactRepoId).not.toBe(first.artifactRepoId);
    expect([first.name, second.name]).toEqual(["app", "app"]);
    expect(repos.size).toBe(2);

    await addMember(first.id, b.user.id, "admin");
    await setProjectSecret(b, { projectId: first.id, name: "SHARED", value: "shared-secret" });
    expect(await env.CREDENTIALS.getByName(a.user.id).listProjectEnvNames(first.id)).toEqual(["SHARED"]);
    expect(await env.CREDENTIALS.getByName(b.user.id).listProjectEnvNames(first.id)).toEqual([]);
    expect(await listProjectSecretNames(a, { projectId: first.id })).toEqual({ names: ["SHARED"] });
  });

  it("counts stars idempotently and keeps usernames and organization slugs in one namespace", async () => {
    const { seeded, ctx: owner } = await seedOwner(`starred-${unique()}`);
    const fan = await seedUser(`fan-${unique()}`);
    const project = { projectId: seeded.projectId };
    await expect(starProject(fan, project)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await setProjectVisibility(owner, { ...project, visibility: "public" });
    await starProject(fan, project);
    expect(await starProject(fan, project)).toEqual({ stars: 1, starred: true });
    expect(await starProject(owner, project)).toEqual({ stars: 2, starred: true });
    expect(await unstarProject(fan, project)).toEqual({ stars: 1, starred: false });
    expect(await unstarProject(fan, project)).toEqual({ stars: 1, starred: false });
    expect((await listStarredProjects(owner, {})).map((p) => [p.id, p.stars, p.starred])).toEqual([
      [seeded.projectId, 1, true],
    ]);
    expect(
      (await exploreProjects({ env, user: null }, {})).find((p) => p.id === seeded.projectId),
    ).toMatchObject({
      stars: 1,
      starred: false,
    });
    await setProjectVisibility(owner, { ...project, visibility: "private" });
    expect(await listStarredProjects(fan, {})).toEqual([]);
    await expect(
      getProject({ env, user: fan.user }, { namespace: "nobody-here", slug: "app" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const taken = new Set(["acme", "octo"]);

    const namespaces: AuthNamespaces = {
      taken: async (name, githubId) => taken.has(name) && githubId !== "7",
      organizationHasProjects: async () => false,
    };

    expect(await usernameFor(namespaces, "Octo", "7")).toBe("octo");
    expect(await usernameFor(namespaces, "Octo", "8")).toBe("octo-8");
    expect(await usernameFor(namespaces, "Settings", "9")).toBe("settings-9");
    await expect(assertOrganizationSlug(namespaces, "fresh-org")).resolves.toBeUndefined();

    for (const slug of ["acme", "explore", "Upper", "-dash", "a".repeat(40)])
      await expect(assertOrganizationSlug(namespaces, slug)).rejects.toMatchObject({
        body: { code: "NAMESPACE_TAKEN" },
      });
  });
});
