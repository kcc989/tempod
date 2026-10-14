# 11 Organizations and Social

Oct 14, 2026 · @Casey Collins

The owner asked for Tempo to work like GitHub: users, organizations, public repositories that anyone can browse, and stars. Only approved project members and owners can trigger agents. This tab takes precedence over the single-owner rules in tabs 00, 02, 05 and 09. Where those tabs say "the owner", read "a user with the role this tab requires".

## Decisions

| # | Decision | Choice |
| --- | --- | --- |
| O1 | Sign-in | Any GitHub account can sign in. GitHub is the only provider. |
| O2 | Anonymous access | Anyone can read public projects without signing in: code, commits, branches, issues, comments, labels and pull requests. |
| O3 | Organizations | The Better Auth `organization` plugin. Its default roles are `owner`, `admin` and `member`. Teams are off. |
| O4 | Project owner | A user (personal project) or an organization (organization project). |
| O5 | Agent credentials | Each user's own CredentialDO, as before. The user who starts a workspace pays for its agents. |
| O6 | Project membership | Per-project members with role `read`, `write` or `admin`. Only `write` and higher can trigger agents. |
| O7 | Social | Stars. Follows, public issue comments by non-members and forks are not in this version. |
| O8 | Phases | Phase 1 is the server, data and spec. Phase 2 is the web UI and the Mac client together (rule 17). |

## Identity

- Better Auth accepts any GitHub account. Every other sign-in method is refused, as before.
- `TEMPO_OWNER_GITHUB_ID` now names the **instance admin**. The instance admin has no implicit access to other users' projects. Only the instance admin can:
  - use `linkArtifactRepository` (Artifacts repositories created outside Tempo belong to the deployment);
  - use `listInstallations`, `listInstallationRepos` and `linkProject`. The GitHub App and its installations belong to the deployment, and `listInstallations` records every installation under the caller. Other users create or import Artifacts repositories;
  - store a Claude subscription token with `setClaudeToken`. Policy (00) forbids a hosted multi-user Tempo to route other people's Claude plan credentials. Other users use an Anthropic API key. `setClaudeToken` from any other user returns `FORBIDDEN`.
- `user` gains `username` (text, unique, nullable for rows from before this tab). It is the lower-case GitHub `login`. If that name is a reserved word (Organizations, below), or an organization slug or another user already has it, the username is `<login>-<githubId>`. Better Auth updates it at each GitHub sign-in (`overrideUserInfoOnSignIn`), so a user from before this tab gets a username at their next sign-in. Until then, the user id is their namespace in function output.
- The Better Auth `/update-user` endpoint is disabled. Users cannot set their own `username`.

## Organizations

- Use the Better Auth `organization` plugin from the pinned `better-auth` package. Clients call its endpoints under `/api/auth/organization/*` directly: the web client with the cookie, the Mac client with its bearer token. They are not Tempo server functions and are not in `packages/protocol`.
- Any signed-in user can create an organization and becomes its `owner`. Invitations are by email address and expire after 48 hours. Tempo sends no email. The invited user sees pending invitations through `/api/auth/organization/list-user-invitations` and accepts one. Acceptance requires the invited email to equal the user's GitHub primary email.
- The organization `slug` is its namespace. It MUST match `^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$`. It MUST NOT equal a username or a reserved word (`api`, `admin`, `device`, `downloads`, `explore`, `history`, `login`, `logout`, `new`, `organizations`, `repositories`, `settings`, `setup`, `stars`, `w`, `workspaces`). The list holds every top-level web route, so `/:namespace` never shadows one. A bad or taken slug is refused with Better Auth error code `NAMESPACE_TAKEN`.
- An organization that owns a project cannot be deleted. Better Auth returns error code `ORGANIZATION_HAS_PROJECTS`.

## Namespaces and project names

- A namespace is a username or an organization slug. Both come from one shared set of names.
- `projects` gains:
  - `organization_id` (text, nullable, FK `organization.id`, `ON DELETE RESTRICT`). Null means a personal project.
  - `slug` (text, not null). The project's name in its namespace.
  - `visibility` (`public` or `private`, default `private`).
- `user_id` keeps its column name. For a personal project it is the owner. For an organization project it is the **project holder**: the user who created or linked it. See Shared project configuration.
- The slug is unique per namespace, ignoring case: unique index `projects_namespace_slug` on `(coalesce(organization_id, user_id), lower(slug))`. A duplicate slug returns `PROJECT_EXISTS`. Slugs follow the repository name rule of 09 and are at most 100 characters.
- The old unique indexes `(user_id, repo_id)` and `(user_id, artifact_repo_id)` are replaced by:
  - `projects_namespace_repo` on `(coalesce(organization_id, user_id), repo_id)`;
  - `projects_artifact_repo` on `artifact_repo_id`. An Artifacts repository belongs to at most one project.
- **Artifacts storage names.** The Artifacts namespace is flat, so a project slug is not its Artifacts name. `createRepository` and `importRepository` name a new repository `t<hash>-<slug>`. `<hash>` is the first 12 lower-case hex digits of SHA-256 of the owner key, which is the organization id or the user id. `repo_name` stores this Artifacts name; `repo_owner` stays `tempo`. Retry recovery (09) finds only names with the caller's owner key, so it cannot link another owner's repository. Rows from before this tab keep their names.
- Migration: existing rows get `organization_id` null, `visibility` `private`, and `slug` = `repo_name`. If the same user has two rows with the same `lower(repo_name)`, every row after the first (by `created_at`, then `id`) gets `<repo_owner>-<repo_name>`, and then `-<id>` if that is still taken.

## Project roles

The effective role is the highest that applies: `admin` > `write` > `read` > none.

| Source | Role |
| --- | --- |
| The user owns the personal project | `admin` |
| The user is an organization `owner` or `admin` of the project's organization | `admin` |
| The user is an organization `member` | `read` |
| A `project_members` row | That row's role |
| The project is `public` | `read`, also for anonymous callers (a **public grant**) |

- A role from the first four sources is a **membership role**. A public grant is not a membership role.
- A private project with no role returns `NOT_FOUND`, so its existence is not shown. A project that the caller can read, but whose function needs a higher role, returns `FORBIDDEN`.
- Removing a member, or lowering a role, takes effect at the next call. A turn that is already running finishes.

```sql
CREATE TABLE project_members (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('read','write','admin')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE project_stars (
  user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
CREATE INDEX project_stars_project ON project_stars(project_id);
```

A `project_members` row cannot name the owner of a personal project (`VALIDATION_FAILED`). Any signed-in user can be a member, also one outside the organization.

## Function access

The auth middleware (02) no longer requires the owner. It reads the session if there is one, then applies the policy of the function. Each policy also needs a signed-in user unless it says "anonymous".

| Policy | Rule | Functions |
| --- | --- | --- |
| `public` | Anonymous allowed. Needs any role on the project, including a public grant. | `getProject`, `listNamespaceProjects`, `exploreProjects`, `getRepository`, `getRepositoryFile`, `listRepositoryCommits`, `listBranches`, `listOpenPullRequests`, `listRepositoryPullRequests`, `getRepositoryPullRequest`, `listRepositoryIssues`, `getRepositoryIssue`, `listRepositoryIssueComments`, `listRepositoryLabels` |
| `star` | Needs any role, including a public grant | `starProject`, `unstarProject` |
| `read` | Needs a membership role of `read` or higher | `getCiPipeline`, `listCiRuns`, `getCiRun`, `getCiJobLog`, `listProjectAgents`, `listProjectMembers`, `listProjectConversations`, `getProjectConversation` |
| `write` | Needs `write` or higher | `createWorkspace`, `startCiRun`, `rerunCiRun`, `cancelCiRun`, `createRepositoryPullRequest`, `updateRepositoryPullRequest`, `createRepositoryIssue`, `updateRepositoryIssue`, `createRepositoryIssueComment`, `createRepositoryLabel`, `updateRepositoryLabel`, `deleteRepositoryLabel` |
| `author` | The comment's author with `write`, or `admin` | `updateRepositoryIssueComment`, `deleteRepositoryIssueComment` |
| `admin` | Needs `admin` | `updateProjectSettings`, `unlinkProject`, `setProjectEnvironment`, `setProjectVisibility`, `putProjectAgent`, `deleteProjectAgent`, `setProjectSecret`, `deleteProjectSecret`, `listProjectSecretNames`, `updateCiPipeline`, `deleteRepositoryIssue`, `putProjectMember` |
| `self` | `admin`, or the member removes their own row | `deleteProjectMember` |
| `user` | Signed in; the function acts only on the caller's own data | `listProjects`, `listStarredProjects`, `createRepository`, `importRepository`, environments, credentials, MCP servers, agent library, `listWorkspaces`, `listModels` |
| `instance admin` | Signed in as the instance admin | `linkArtifactRepository`, `setClaudeToken`, `listInstallations`, `listInstallationRepos`, `linkProject` |

- `createRepository`, `importRepository` and `linkProject` take optional `organizationId` and `visibility` (default `private`). With `organizationId`, the caller MUST be an organization `owner` or `admin` (`FORBIDDEN`), and the project's namespace is the organization.
- **Workspace functions.** A workspace belongs to the user who created it, as before; other users get `NOT_FOUND`. The owner of the workspace also needs `write` on its project for every workspace function, WebSocket channel, attachment and artifact route, except these: `getWorkspace`, `markViewed`, `setPinned`, `sleepWorkspace`, `archiveWorkspace`, `deleteWorkspace`, `cancelTurn`, `cancelRun`, `stopScript`. A user who lost `write` can still stop and clean up their own workspaces, so `unlinkProject` is never blocked forever.
- Agent issue tools (09) act as the workspace's user. They work only while the workspace passes the `write` check above.
- `listProjects` returns the projects where the caller has `write` or higher. These are the projects where they can create workspaces.

## Shared project configuration

Agent credentials and MCP servers belong to the user who starts the workspace (O5). Project configuration is shared by every member, so it uses the **project holder** (`projects.user_id`):

- Project secrets live in the holder's CredentialDO under the existing keys. An `admin` sets them there. Every workspace of the project reads them from there.
- The project environment (`projects.environment_id`) MUST be an environment of the holder. Its secrets and injectors use the holder's CredentialDO. A workspace override environment (`setWorkspaceEnvironment`) MUST be an environment of the workspace's user, and uses that user's CredentialDO. `getEgressConfig` adds `environmentUserId` for `TempoOutbound`.
- Project agent attachments (`project_agents`) MUST reference agents of the holder. Agent proposals that change the library apply only in the holder's own workspaces, as before.
- CI runs use the holder's credentials, as before (10).

## Server functions

| Function | Method | Input | Output | Errors |
| --- | --- | --- | --- | --- |
| `getProject` | GET | `{namespace, slug}` | `ProjectSummary` | `NOT_FOUND` |
| `listNamespaceProjects` | GET | `{namespace, offset?}` | `ProjectSummary[]`, at most 50, by slug | `NOT_FOUND` for an unknown namespace |
| `exploreProjects` | GET | `{offset?}` | Public `ProjectSummary[]`, at most 50, by stars, then most recently updated, then id | — |
| `setProjectVisibility` | POST | `{projectId, visibility}` | `Project` | — |
| `listProjectMembers` | GET | `{projectId}` | `ProjectMember[]`, by username | — |
| `putProjectMember` | POST | `{projectId, username, role}` | `ProjectMember`; adds or changes the row | `NOT_FOUND` for an unknown user |
| `deleteProjectMember` | POST | `{projectId, userId}` | `{}`; a missing row is not an error | — |
| `starProject` | POST | `{projectId}` | `{stars, starred}` | — |
| `unstarProject` | POST | `{projectId}` | `{stars, starred}` | — |
| `listStarredProjects` | GET | `{offset?}` | `ProjectSummary[]` the caller can still read, at most 50, most recent star first | — |

- `ProjectSummary` = `{id, namespace, slug, organizationId (nullable), visibility, provider, owner, name, defaultBranch, stars, starred, role (nullable), updatedAt}`. `owner` and `name` are the same as in `Project`, so a client can link a GitHub-linked project to GitHub. `starred` is false for anonymous callers. `role` is the caller's membership role, or null; a public grant is not a role here, because `visibility` already shows it.
- `ProjectMember` = `{userId, username (nullable), name, image (nullable), role}`.
- `Project` gains optional `organizationId`, `namespace`, `slug`, `visibility` and `role`. They are optional so older fixtures still decode. `role` is the membership role, as in `ProjectSummary`. For an Artifacts project, `Project.name` and `RepositoryDetail.name` are the slug, not the Artifacts storage name.
- `starProject` and `unstarProject` are idempotent.
- `listNamespaceProjects` and `exploreProjects` never return a project the caller cannot read. Anonymous callers see only public projects.

## Security

- Anonymous server function calls go only through the cookie path (`createServerFn`) with no cookie. `/api/v1/rpc` accepts the same anonymous calls without a bearer token. The anonymous policy list above is closed: every other function returns `UNAUTHENTICATED` with no session.
- Public reads use the same Artifacts and GitHub tokens as member reads. Tokens never appear in output (09).
- CI logs and project conversations can hold project details, so they need a membership role, never a public grant.
- `FORBIDDEN` now means "You don't have access to this."

## Phase 2: web and Mac

Phase 2 changes the web UI and the Mac client together. The pages, controls and copy are in 04, Public projects, stars and organizations, and the Mac rows of 07, Scope.

## Validation

Required tests: migration of existing projects (slug, visibility and duplicate names); every policy row, including anonymous access to a public project and `NOT_FOUND` for a private one; a removed member's workspace refused for `sendPrompt` but allowed for `archiveWorkspace`; Artifacts names that cannot link another owner's repository; organization slug refused when it equals a username or a reserved word; star idempotency and counts; the project holder's secrets reaching a member's workspace.
