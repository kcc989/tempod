# 11 Public Profile

Oct 14, 2026 · @Casey Collins

The owner asked for GitHub-like public pages for a solo builder: a profile, public repositories that anyone can read, and pinned repositories. Tempo stays a single-owner deployment (00, 05). Nobody else signs in, and only the owner can trigger agents. This tab extends 02, 04, 05, 07 and 09 for that scope.

## Decisions

| # | Decision | Choice |
| --- | --- | --- |
| P1 | Users | One owner, as before. Nobody else can sign in. |
| P2 | Visibility | Each project is `private` (default) or `public`. |
| P3 | Anonymous access | Anyone can read the code of a public Artifacts project without signing in: directories, files, commits and branches. Issues, pull requests, checks, conversations and workspaces stay owner-only for every project. |
| P4 | Profile | `/:username` shows the owner's name, avatar, GitHub bio and public projects. |
| P5 | Pins | The owner pins up to 6 public projects. They show first on the profile. |
| P6 | URLs | `/:username` and `/:username/:slug`. |
| P7 | Not in this version | Organizations, members, roles, stars, follows, forks, an explore page, and comments by visitors. |
| P8 | Phases | One phase: spec, server, web and Mac together (rule 17). |

A **visitor** is a caller with no session, or with a session that is not the owner's.

## Identity

- `user` gains `username` (text, unique, nullable) and `bio` (text, nullable). Better Auth sets both at each GitHub sign-in (`overrideUserInfoOnSignIn` with `mapProfileToUser`). Rows from before this tab get them at the owner's next sign-in.
- `username` is the lower-case GitHub `login`. If that name is a reserved word, or another user row already has it, the username is `<login>-<githubId>`.
- Reserved words are the top-level paths of the app: `api`, `assets`, `device`, `downloads`, `history`, `login`, `logout`, `repositories`, `settings`, `setup`, `w`, `workspaces`. So `/:username` never shadows a route.
- `bio` is the GitHub profile `bio`, trimmed and cut to 160 characters. An empty bio is null.
- The Better Auth `/update-user` endpoint is disabled. The owner cannot set `username` or `bio` by hand.
- Until the owner has a username, `getProfile` and `getPublicProject` return `NOT_FOUND` and `Project.username` is null.

## Projects

`projects` gains:

- `slug` (text, not null). The project's name in the owner's URLs.
- `visibility` (`public` or `private`, default `private`).
- `pinned_at` (integer, nullable). Unix milliseconds of the pin; null means not pinned.

Unique index `projects_user_slug` on `(user_id, lower(slug))`.

- **Slug.** When a project is created, linked or imported, its slug is the first of these that the user does not already have, ignoring case: `<repo_name>`, `<repo_owner>-<repo_name>`, `<repo_owner>-<repo_name>-<id>`. A slug never changes after that.
- **Migration.** Existing rows get `visibility` `private`, `pinned_at` null and the same slug rule, applied in order of `created_at`, then `id`.
- **Visibility.** `setProjectVisibility` to `private` also clears `pinned_at`.
- **Pins.** Only a public project can be pinned. A user has at most 6 pinned projects. A 7th pin, or a pin of a private project, returns `VALIDATION_FAILED`. Pinning a pinned project keeps its first `pinned_at`. Unpinning an unpinned project is not an error.
- Both functions set `updated_at`.

## Function access

The auth middleware (02) reads the session if there is one, then applies the function's policy.

| Policy | Rule | Functions |
| --- | --- | --- |
| `visitor` | Runs without a session. The owner gets the owner rules. A visitor can read only public projects; any other project returns `NOT_FOUND`. | `getProfile`, `listProfileProjects`, `getPublicProject`, `getRepository`, `getRepositoryFile`, `listRepositoryCommits`, `listBranches` |
| `owner` | As before (02): no session is `UNAUTHENTICATED`, a session that is not the owner's is `FORBIDDEN`. | Every other function, channel, attachment and artifact route |

- For a visitor, `listBranches` works only for Artifacts projects. A GitHub-linked project returns `NOT_FOUND`, so visitors never cause GitHub API calls.
- For a visitor, `RepositoryDetail.remote` is the empty string. The Artifacts URL names the Cloudflare account, and cloning needs a token that a visitor cannot get.
- Visitors never get `UNAUTHENTICATED` or `FORBIDDEN` from a `visitor` function.

## Server functions

| Function | Method | Input | Output | Errors |
| --- | --- | --- | --- | --- |
| `getProfile` | GET | `{username}` | `Profile` | `NOT_FOUND` |
| `listProfileProjects` | GET | `{username, offset?}` | Public `ProjectSummary[]`, at most 50: pinned first by `pinned_at`, then most recently updated, then id | `NOT_FOUND` for an unknown username |
| `getPublicProject` | GET | `{username, slug}` | `ProjectSummary` | `NOT_FOUND` unless the project is public |
| `setProjectVisibility` | POST | `{projectId, visibility}` | `Project` | — |
| `setProjectPinned` | POST | `{projectId, pinned}` | `Project` | `VALIDATION_FAILED` |

- `username` and `slug` lookups ignore case.
- `getPublicProject` and `listProfileProjects` return only public projects, also to the owner. The profile shows what visitors see.
- `Profile` = `{username, name, image (nullable), bio (nullable)}`.
- `ProjectSummary` = `{id, username, slug, provider, owner, name, defaultBranch, pinned, updatedAt}`. `owner` and `name` are the same as in `Project`, so a client can link a GitHub-linked project to GitHub.
- `Project` gains optional `username` (nullable), `slug`, `visibility` and `pinned`. They are optional so older fixtures still decode. `listProjects`, `setProjectVisibility` and `setProjectPinned` fill `username`; other functions leave it out.

## Security

- Anonymous calls go through the cookie path (`createServerFn`) with no cookie, and through `/api/v1/rpc` with no bearer token. The `visitor` list above is closed.
- Visitor reads use the same Artifacts binding as owner reads. Tokens never appear in output (09).
- Public pages show commit author names and email addresses, as Git does. The confirm dialog for `Public` says so.
- This version adds no rate limit of its own. The owner can add Cloudflare rate-limiting rules on `APP_HOST` (05 allows extra layers).

## Clients

The pages, controls and copy are in 04, Public profile, and the Mac rows of 07, Scope.

## Validation

Required tests: migration of existing projects (slug, duplicate names, visibility); username rules (reserved word, taken name, bio); visitor reads of a public project's code; `NOT_FOUND` for a private project and for a public GitHub-linked project's branches; visitors refused for issues, pull requests and checks of a public project; an empty `remote` for visitors; pin limit, pin of a private project, and unpin on `private`; profile order; generated TypeScript and Rust schemas.
