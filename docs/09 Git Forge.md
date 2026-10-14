# 09 Git Forge

The owner requested Artifacts-hosted Git repositories, repository browsing, pull requests and issue tracking in Tempo. This tab extends tabs 00–08 for that scope and takes precedence over their GitHub-only repository assumptions. Tempo remains an owner-operated deployment; GitHub sign-in and optional GitHub-linked projects remain supported. It is not yet a public, multi-user forge.

## Storage and identity

- Cloudflare Artifacts owns Git objects, branches and transport. Use the `Artifacts` Workers binding and its generated types in `apps/tempo/worker-runtime.d.ts`, with no additional SDK.
- The binding is `ARTIFACTS`. The default namespace is `tempo-repos`; deployment may select `TEMPO_ARTIFACTS_NAMESPACE`.
- `projects` gains `provider` (`github` by default, or `artifacts`), `artifact_repo_id` (nullable text), and `clone_url` (nullable text). `installation_id` and `repo_id` become nullable; native projects have neither. GitHub project rows and workspace rows MUST survive the forward migration.
- Relaxing the existing SQLite NOT NULL constraint requires reconstruction of `projects`. Extending the Durable Object `ops.kind` CHECK requires reconstruction of `ops`. These preservation-tested forward migrations are permitted by 05 provided they preserve existing columns, values, foreign keys, indexes and dependent rows. Later migrations remain additive by default.
- Artifacts project `repo_owner` is `tempo`, and `repo_name` is the namespace repository name. Each owner may link a given Artifacts repository only once. `artifact_repo_id` is the service's opaque ID.
- `Project` has nullable `installationId` and `repoId` and optional `provider`, `artifactRepoId` and `cloneUrl`. Missing provider means GitHub for older fixtures. The Mac client minimum version becomes `0.2.0`; the new native client must be deployed alongside this schema extension.
- Unlinking an Artifacts project removes Tempo metadata according to the existing archive guard. It MUST NOT delete the remote repository. No remote deletion UI is part of this phase.

## Repository API

Every function uses the existing owner authentication, schema validation, Result envelope and both server-function and `/api/v1/rpc` wrappers. Project-scoped functions MUST check project ownership before calling Artifacts. Initial and minted tokens MUST NOT appear in outputs.

| Function | Method | Input | Output |
| --- | --- | --- | --- |
| `createRepository` | POST | `{name, description?, defaultBranch?}` | `Project` |
| `importRepository` | POST | `{name, url, description?}` | `Project` |
| `linkArtifactRepository` | POST | `{name}` | `Project` |
| `getRepository` | GET | `{projectId, ref?, path?}` | `RepositoryDetail` |
| `getRepositoryFile` | GET | `{projectId, ref, path}` | `{content, encoding, size}` |
| `listRepositoryCommits` | GET | `{projectId, ref?, offset?}` | `RepositoryCommit[]` |
| `listRepositoryPullRequests` | GET | `{projectId, state?: open \| closed \| all}` | `RepositoryPullRequest[]` |
| `getRepositoryPullRequest` | GET | `{projectId, number}` | `RepositoryPullRequest` |
| `createRepositoryPullRequest` | POST | `{projectId, title, body, headBranch, baseBranch, draft}` | `RepositoryPullRequest` |
| `updateRepositoryPullRequest` | POST | `{projectId, number, title?, body?, state?: open \| closed, draft?}` | `RepositoryPullRequest` |

- Repository names are alphanumeric plus dots, hyphens and underscores, with no slash, whitespace or control characters. The Artifacts service remains authoritative for its limits. Default branch is `main` unless provided; validate it as a Git branch.
- Import accepts a public HTTPS Git URL without userinfo, query credentials or fragments. Artifacts does not import private remotes with authentication; private migration can use ordinary client-side Git clone and push outside this import flow.
- Create/import retries MUST recover a repository created before the response or D1 insert was lost, linking the existing repository of the same owner namespace and name. They MUST NOT overwrite or delete existing Git content. Repeated linking returns the existing project.
- Returning a cached linked project or using a cached Git token MUST recheck its immutable Artifacts repository ID. A repository deleted and recreated under the same name is a different object and returns `NOT_FOUND` for the stale project.
- The creation token is transient and unused by the UI. Revoke it where the service permits; never persist it in D1, R2, events or logs.
- `RepositoryDetail` fields are `projectId`, `name`, `description` (nullable), `defaultBranch`, `remote`, `readOnly`, `ref`, `empty`, `entries`, and `commit` (nullable). Each entry has `name`, repository-relative `path`, `hash`, and `type` (`tree`, `blob`, `symlink`, `gitlink`, `exec`). Browse directories by walking tree hashes from the resolved commit. Never traverse symlinks or submodule contents.
- `RepositoryCommit` matches Artifacts metadata: `hash`, `treeHash`, `message`, `author` and `committer` (each `{name,email}`), `parents`, `authoredAt`, `committedAt` (Unix seconds). History pages contain at most 50 commits; offset is a nonnegative integer.
- Missing default branch in a completely empty repository returns `empty: true`. An explicit missing ref or path returns `NOT_FOUND`.
- Browse refs accept `HEAD`, a branch or tag name, or a full lowercase 40-character commit SHA. Ref strings are bounded to 250 characters; controls and revision expressions are rejected before binding calls.
- File preview is capped at 1 MiB; larger files return `FILE_TOO_LARGE`. Valid UTF-8 returns `utf8`, otherwise `base64`. Raw file content is rendered as text, never HTML. Paths reject absolute paths, backslashes, control characters, empty interior segments and `.`/`..`; only directory root may be empty.
- A read-only repository can be browsed. New editing workspaces, PR creation and Git merges are disabled in both clients and rejected with `FORBIDDEN` before mutation. Existing PR metadata can still be read, edited or closed; these actions do not write Git.
- Existing `listBranches` and `listOpenPullRequests` select the project provider. Artifacts branches are obtained using documented smart HTTPS Git ref advertisement with a bounded parser. Only `refs/heads/` are exposed. Advertisements over 2 MiB fail safely.
- `ARTIFACTS_NOT_CONFIGURED` means the binding is unavailable; `ARTIFACTS_API_ERROR` means the service could not complete a call. Map missing objects to `NOT_FOUND`, invalid input to `VALIDATION_FAILED`, duplicate PRs to `PR_EXISTS`, and merge conflicts/stale refs to `PR_NOT_MERGEABLE`. Never expose raw upstream exception text that might contain credentials.

## Git transport and empty repositories

- Clone from the trusted remote URL returned by Artifacts. It MUST be credential-free HTTPS on the documented Artifacts Git service, never a user-selected token destination.
- Binding operations require no API token. Git transport uses a repository-scoped token created through the binding, with short expiry and a bounded in-memory cache. Worker and WorkspaceDO caches distinguish GitHub and Artifacts tokens.
- Native egress injection precedes the ordinary allowlist rule. It matches HTTPS, the exact trusted remote hostname and repository path boundary (including only its Git transport endpoints), and sets `Authorization: Bearer <repo token>`. It MUST NOT inject into another repository, plaintext HTTP, arbitrary Cloudflare API paths, or redirects outside this scope. Strip client credentials before forwarding. APP_HOST stays blocked.
- The Cloudflare account API token never enters a container or runtime project metadata. Native repositories never mint GitHub installation tokens.
- Commit identity for native workspaces comes from the authenticated owner's name and email, with a deterministic Tempo fallback; no GitHub API lookup is needed.
- `repo.clone` gains optional `initializeEmpty`. Only native repos set it. If the requested new workspace starts from the native default base and the remote is entirely empty, create one empty initial commit and push the base branch, then create the workspace branch. Concurrent initializers MUST converge on the pushed base and MUST NOT overwrite it. Existing branch/PR sources must still fail when their remote branch is missing.
- Archive branch deletion uses the selected backend and MUST never delete the repository default/base branch.

## Tempo pull requests

Artifacts provides Git storage, not pull requests. D1 table `pull_requests` owns native PR metadata. Columns: `id` (text primary key), `project_id` (project FK), `number` (integer), `title`, `body`, `head_branch`, `base_branch`, `state` (`open`, `draft`, `merged`, `closed`), nullable `head_sha`, `base_sha`, `merge_sha`, integer `created_at`, `updated_at`, nullable `merged_at`. Numbers are unique per project; allocation is atomic. At most one open/draft PR exists for a head branch per project. All queries and mutations are scoped to an owned Artifacts project.

- `RepositoryPullRequest` has the camel-case fields above plus an owner-only Tempo `url`. Numbers start at 1. Open listing includes drafts; closed listing includes merged PRs.
- Creation requires two distinct existing branches. Store their current tips. Title/body length and number/ref inputs are bounded and validated. Duplicate open-head creation returns `PR_EXISTS`; retry and race must not create two PRs.
- PRs can be created, read, edited, closed and reopened without starting a container. Merged PRs cannot reopen or change their merge result. Reopen enforces the open-head uniqueness rule and refreshes branch tips.
- Workspace `createPullRequest`, `refreshPullRequest`, `listCheckRuns`, `createWorkspace` with a PR source and `mergePullRequest` select native metadata for Artifacts projects. Native check runs are empty until a future CI integration; the UI MUST NOT invent passing checks.
- Opening a PR reuses a live head-branch workspace when one exists. Native `createPullRequest` adopts an existing open PR after verifying the actual remote head and repository ID, even when the workspace has not recorded its first push. Adoption synchronizes the PR's base in the WorkspaceDO, D1 and daemon without clearing local changes. A changed remote after a revert rejects adoption instead of widening an outstanding force-push lease.
- Open a PR's head in a workspace to review its diff and merge. Merging requires a ready container with no active conflicting Git/agent operation. A sleeping workspace is woken through the existing lifecycle before retrying the merge action.
- Native merges support `merge` and `squash`. Native `rebase` returns `PR_NOT_MERGEABLE` with a clear supported-method message. GitHub retains its existing methods.
- The daemon adds `git.merge` with `{baseBranch, headBranch, method: merge \| squash, headSha, baseSha, operationId}` → `{commitSha}`. It fetches the exact remote tips, validates expected SHAs, computes the merge using Git object operations and pushes with compare-and-swap protection for the base tip. It MUST leave the current branch, user's files and index unchanged. Conflicts or changed tips fail before pushing. The operation identifier permits retry after a lost push acknowledgement without creating another merge.
- Native merges reserve a durable `merge_pr` operation with one `git.merge` step (five minute timeout, one attempt). The caller awaits its Result. While it is pending or running, prompt execution and sleep/archive admission obey the existing operation runner's exclusion rules. A merge failure does not change the workspace lifecycle state. Retrying the action reconciles an already-pushed result before attempting another merge.
- Mark the PR merged only after the target ref is confirmed pushed. Record `merge_sha` and `merged_at`. A successful remote push with a lost metadata acknowledgement must be recoverable on retry. Closing a PR never changes a Git ref.
- `git.deleteBranch` `{branch}` → `{}` performs native archive deletion through Git transport. Both new daemon operations have explicit deadlines below their protocol timeout and tests in the pinned container.
- The updated daemon is version `0.2.0`, matching the Worker release. New native Git operations require its rebuilt image; old GitHub-only containers retain their existing operations until sleep/restart.
- Native branch deletion runs before container shutdown. If branch deletion is enabled and a native workspace is already sleeping, archive fails before changing state with `WORKSPACE_BUSY` and asks the owner to wake it and retry. It never silently skips the configured deletion.

## Tempo issues

Issue metadata lives in D1 independently of Git storage. All issue, comment and label functions use the existing owner authentication and require an owned Artifacts project. GitHub-linked projects retain external GitHub issue links. These operations work without a container or Artifacts binding and remain available for read-only repositories; they never change Git objects or refs. A remotely deleted repository does not erase its local project issues.

| Function | Method | Input | Output |
| --- | --- | --- | --- |
| `listRepositoryIssues` | GET | `{projectId, state?: open \| closed \| all, query?, labelId?, offset?}` | `RepositoryIssue[]` |
| `getRepositoryIssue` | GET | `{projectId, number}` | `RepositoryIssue` |
| `createRepositoryIssue` | POST | `{projectId, title, body?, labelIds?}` | `RepositoryIssue` |
| `updateRepositoryIssue` | POST | `{projectId, number, title?, body?, state?: open \| closed, labelIds?}` | `RepositoryIssue` |
| `listRepositoryIssueComments` | GET | `{projectId, number, offset?}` | `RepositoryIssueComment[]` |
| `createRepositoryIssueComment` | POST | `{projectId, number, body}` | `RepositoryIssueComment` |
| `updateRepositoryIssueComment` | POST | `{projectId, number, commentId, body}` | `RepositoryIssueComment` |
| `deleteRepositoryIssueComment` | POST | `{projectId, number, commentId}` | `{}` |
| `listRepositoryLabels` | GET | `{projectId}` | `RepositoryLabel[]` |
| `createRepositoryLabel` | POST | `{projectId, name, color, description?}` | `RepositoryLabel` |
| `updateRepositoryLabel` | POST | `{projectId, labelId, name?, color?, description?}` | `RepositoryLabel` |
| `deleteRepositoryLabel` | POST | `{projectId, labelId}` | `{}` |

- `IssueState` is `open` or `closed`. `RepositoryIssue` has `id`, `projectId`, `number`, `title`, `body`, `state`, `authorId`, `createdAt`, `updatedAt`, nullable `closedAt`, `url`, `labels` and `commentCount`. Numbers start at 1 and are allocated atomically per project, independently of pull-request numbers. The URL is `/repositories?project=<id>&tab=issues&issue=<number>` on the app host.
- `RepositoryIssueComment` has `id`, `issueId`, `authorId`, `body`, `createdAt` and `updatedAt`. `RepositoryLabel` has `id`, `projectId`, `name`, `color`, `description`, `createdAt` and `updatedAt`. All timestamps are Unix milliseconds. Authors come from the authenticated user, never client input.
- D1 tables are `issues`, `issue_comments`, `labels` and `issue_labels`. Their fields use snake case, matching the wire types except derived issue `url`, `labels` and `commentCount`. `issues` references `projects`; comments and assignments reference issues; labels reference projects. Project/issue/label deletions cascade through their dependent metadata. There is no issue deletion API.
- `issues` has a unique `(project_id, number)` and index `(project_id, state, number)`. `issue_comments` has index `(issue_id, created_at)`. Labels also store `name_key`, the lowercase name, unique per project. `issue_labels` has composite primary key `(issue_id, label_id)` and foreign keys with cascade deletion. Assignments must belong to the same project; validate before mutation.
- Lists return at most 50 issues or comments per page. Offset must be a nonnegative safe integer; issue number must be a positive safe integer. Issues default to open and sort by number descending. Query searches title and body as literal case-insensitive text. Label filtering requires a label owned by the project. Comments sort by creation time then ID ascending. Labels list all project labels, sorted by name.
- Titles are trimmed and must contain 1–256 characters. Issue body defaults to empty and is limited to 65,536 characters. Comment bodies are trimmed, nonempty and limited to 65,536 characters; comments may be added to closed issues. Every successful comment create/edit/delete updates the issue's activity timestamp. Failed or cross-issue mutations leave history unchanged.
- Close preserves the issue and discussion and sets `closedAt`; repeated close preserves the first close time. Reopen clears `closedAt`. Editing title, body, state and labels is atomic. Missing optional fields retain their value; an empty label array clears assignments.
- Label names are trimmed, contain 1–64 characters and are unique case-insensitively within a project. Color is exactly six hexadecimal digits without `#`, normalized lowercase. Description defaults to empty and is limited to 256 characters. Each project has at most 100 labels; each issue has at most 25 distinct label assignments. Enforce the project cap atomically. Deleting a label detaches its assignments and preserves issues and comments.
- Invalid values, duplicate names, exceeded limits and labels assigned or filtered outside the project return `VALIDATION_FAILED`; missing or cross-project issue, comment and label CRUD records return `NOT_FOUND`. Database failures return a safe error without logging bound issue/comment content. Comments and issue descriptions are rendered through the existing safe text/Markdown surfaces, without raw HTML or external tracking images.

## Web and Mac

- Add a Repositories entry reachable from the sidebar and the empty home state. The list shows existing projects with their backend and provides native create, public import and link-existing actions.
- `/` is the repository dashboard; `/repositories` selects a repository through its search parameters. `/workspaces` retains the mobile workspace list.
- Native repository view includes a branch/ref picker, directory breadcrumbs and entries, bounded file preview, commit history and clone URL copy. An empty repo explains how to start a workspace or push the first commit.
- Empty-repository Start workspace creates a new workspace on the default base without a prompt or agent login gate, so Git bootstrapping can run before configuring an agent. The full New workspace dialog retains agent selection and prompt controls.
- Pull requests include list, create, detail, body, head/base branches, state and close/reopen controls. Open in workspace enters the existing review and Git workflow. Repository and PR links for native projects MUST point to Tempo; GitHub projects keep GitHub links.
- The native app adds the same repository browsing and PR RPCs with loading/error states, creation/import and native PR controls. Its state stays in memory; only existing layout/preferences persist locally.
- Both clients add an Issues tab with open/closed/all lists, title/body search, label filtering, issue creation and editing, close/reopen, discussion comments with edit/delete, and label creation/edit/delete and assignment. Deep links select the requested issue and pagination exposes older issues/comments. Loading and error states remain actionable.
- Both clients use shared generated protocol types. No new dependency is required.

## Deployment and validation

Configure the `ARTIFACTS` binding with `namespace: tempo-repos` or the selected namespace in local and deploy configs. No account token belongs in Worker vars. Artifacts requires Workers Paid and is in open beta. Apply migrations before the new Worker runs; deploy a compatible Mac client. Deployment still requires the owner's explicit approval under the existing operational policy, after code and verification are reviewable.

Required verification: old-schema migration preservation; owner/ref/path checks; create/import retry; token secrecy and exact egress scope; empty remote bootstrapping; concurrent/duplicate PR creation; close/reopen; issue/comment CRUD and activity timestamps; label uniqueness, cap and cross-project isolation; issue pagination and safe rendering; actual merge/squash and lost-ack retry; branch/file/history UI states; generated TypeScript/Rust schemas; `bun run typecheck`, `bun run lint`, `bun run test`, format/version/build checks and daemon container tests. Live Artifacts and hosted agent acceptance are separate from mocked local tests.

## Sources

- [Cloudflare Artifacts launch](https://blog.cloudflare.com/next-git-platform-on-cloudflare/)
- [Cloudflare Artifacts docs source](https://github.com/cloudflare/cloudflare-docs/tree/production/src/content/docs/artifacts)
- Generated Workers contracts in `apps/tempo/worker-runtime.d.ts` and pinned Wrangler/Alchemy schemas.
