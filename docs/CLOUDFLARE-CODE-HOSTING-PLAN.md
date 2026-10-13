# Cloudflare code hosting, custom images, and safe CI

Status: proposed implementation plan. Research checked on October 12, 2026.

This document records the complete plan discussed with the owner. It does not change the Tempo Spec, add runtime behavior, or authorize a deployment. The spec tabs remain the source of truth. Each implementation phase must first define its exact contracts and update the affected tabs in the same pull request.

## Scope and confirmed choices

The owner confirmed these choices:

- Support repositories managed by Tempo. Migrating Tempo's own source repository and CI is outside this plan.
- Offer Cloudflare Artifacts as an alternative to GitHub for project code hosting.
- Include review and merge in Tempo in the first Artifacts release.
- Support custom images for both agent workspaces and CI, with separate images.

The design below is a recommendation. Class names, file names, release fields, policies, and sequencing that are new to Tempo are proposed, not approved wire contracts. Exact tables, routes, message types, error codes, and limits must be settled in the spec before implementation. New wire types belong only in `packages/protocol`, using Effect Schema.

Tempo currently serves one trusted owner on that owner's Cloudflare account. Keep that deployment model for this work. A hosted service with untrusted users needs a separate product and tenancy decision. Still scope every repository, release, capability, and run to its owner so the design can support that later.

## Current implementation and Cloudflare support

Tempo's `GitProvider` interface is a useful starting point, but it is still shaped around GitHub installation tokens, owner/name pairs, and GitHub pull requests. Callers import the GitHub provider directly. Project identity requires numeric GitHub repository and installation IDs. Workspace creation, check polling, branch deletion, links, and both clients also assume GitHub.

The daemon already accepts a clone URL and uses ordinary Git. Checkpoints, bundles, transcripts, and home backups can keep their current ownership and durability rules. Existing Artifacts support stores custom-agent definitions in `tempo-agents`; project repositories and execution definitions need separate namespaces.

| Area | Verified support or constraint | Consequence |
| --- | --- | --- |
| Artifacts transport | Git smart HTTPS supports clone, fetch, pull, and push. Optional Git capabilities such as `filter` are not supported. [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/) | Reuse ordinary Git, with provider-specific clone options. Omit `--filter=blob:none` for Artifacts. |
| Artifacts control plane | Workers bindings and REST provide repository creation, listing, imports, forks, reads, history, and token management. The reviewed references do not document pull requests, reviews, branch protection, check reporting, or a ref-update/CAS API. [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/), [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/) | Tempo must own Artifacts review/check state. Prove expected-SHA ref updates through Git before enabling merge. |
| Git credentials | Artifacts Git tokens have repository-wide `read` or `write` scope and support expiry and revocation. [Authentication](https://developers.cloudflare.com/artifacts/guides/authentication/) | Hiding a write token does not restrict which branch a container can push. Use a trusted canonical publisher. |
| Push events | `cf.artifacts.repo.pushed` identifies the repository, ref, and before/after commits. [Events](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/) | Build from the exact commit. Handle duplicate, delayed, missed, and deletion events. |
| Repository limits | Current limits are 1 GB per repository and 32 MB per blob. [Artifacts limits](https://developers.cloudflare.com/artifacts/platform/limits/) | Check size before import and before publishing large objects. |
| Imports | The import API documents public HTTPS sources. [Import guide](https://developers.cloudflare.com/artifacts/guides/import-repositories/) | Private migration needs authenticated clone and push through Tempo's credential boundary. |
| Custom CI | `@cloudflare/ci` supplies Workflows orchestration, isolated command runners, and dependency caching. Managed Workers Builds is a separate service. [CI guide](https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/) | Use the SDK for project checks after its compatibility gate. Use an independent image publication flow. |
| SDK compatibility | Upstream currently declares `@cloudflare/ci` 0.2.0, depends on Sandbox 0.12.1, and calls `getSandbox`, `startProcess`, and `createBackup`. [Manifest](https://raw.githubusercontent.com/cloudflare/ci/main/package.json), [Runner](https://raw.githubusercontent.com/cloudflare/ci/main/src/ci/runners/sandbox.ts) | It cannot be adopted unchanged under Tempo's Sandbox 1.0 rules. |
| SDK security and cache | The SDK can inject source/deployment credentials into command environments. Logs are raw. Cached source restoration leaves deleted files behind. [Step execution](https://raw.githubusercontent.com/cloudflare/ci/main/src/ci/capabilities.ts), [Runner](https://raw.githubusercontent.com/cloudflare/ci/main/src/ci/runners/sandbox.ts) | Replace those paths before use. Prevent credentials entering untrusted execution, sanitize output, and verify clean source restoration. |
| SDK image selection | Public runner options have no image selector. [Runner options](https://raw.githubusercontent.com/cloudflare/ci/main/src/pipeline/types.ts) | Add a reviewed image-selection seam during the Sandbox 1.0 migration. |
| Container images | Under `durable_object` scheduling, digest-pinned images come from the deployed named image map. It supports up to 100 names. External images must first be copied into Cloudflare Registry. [Image management](https://developers.cloudflare.com/containers/guides/image-management/) | Image publication includes registration through a Worker deployment. Do not promise arbitrary runtime image URLs. |
| Image builds | Workers Builds supports Dockerfile builds. [Container deployment](https://developers.cloudflare.com/containers/guides/deploy/) | Qualify it as an image builder, with build and publication privileges separated. |
| Dynamic Workers | Explicit bindings and `globalOutbound: null` can limit runtime-loaded code. CPU and subrequest limits are configurable. [Bindings](https://developers.cloudflare.com/dynamic-workers/usage/bindings/), [Egress](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/), [Limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/) | Use them for optional custom JS/TS planning, with a small capability surface. |

These are dated findings, not live acceptance evidence. Recheck the pinned packages and platform contracts during the first phase. Do not copy examples that use old Sandbox APIs, mutable tenant-only code lookup, broad credentials, or fields that differ from the installed Wrangler schema.

## Proposed architecture and ownership

| Component | Owns | Access boundary |
| --- | --- | --- |
| Tempo Worker | Authentication, project connections, owner settings, provider selection, release selection, client API | Trusted control plane. GitHub sign-in remains a separate dependency. |
| WorkspaceDO | Its workspace state, transcript, checkpoints, operations, and D1 workspace summary | Only this DO writes its SQLite and workspace row after the existing first insert. |
| Repository coordinator DO | Artifacts review/check/merge metadata, publish intent, and coordination across workspaces | Proposed component. Review history survives workspace deletion. It does not duplicate transcripts. |
| Trusted Git publisher | Validated bundle import and authorized ref updates | No repository scripts or hooks execute. Write targets come from trusted state. |
| Trusted CI Worker and Workflows | Plan validation, job admission, execution, cancellation, and verified results | No arbitrary user modules are imported into this Worker. |
| Dynamic Worker | Optional user-authored JS/TS that returns a pipeline plan | No network, raw credentials, storage namespaces, or publisher access. |
| CI container | Build and test commands for a pinned project commit and runtime release | Read-only canonical repository access; bounded egress and resources. |
| Image builder | Untrusted image recipes and isolated build context | No Tempo deployment credentials in build processes or context. |
| Trusted publication service | Image publication, image registration, and any later application deployment | Receives validated outputs and owner-approved targets. |

The SDK stays on the trusted side after its Sandbox 1.0 and credential migration. User pipeline code must not receive its full environment or runner options, which currently allow requests for secrets and deployment credentials.

## Repository providers and migration

Separate repository operations, review operations, and check operations instead of requiring every provider to emulate GitHub pull requests.

- Add provider-qualified project identity. Keep the immutable repository ID as well as account, namespace, name, and returned remote. A reused name must not inherit the previous repository's authority or results.
- Include repository discovery/linking, branch inspection, clone options, remote resolution, and display links in the provider boundary. Use capability declarations for provider-specific features.
- Migrate existing projects as GitHub projects. Do not invent GitHub installation IDs for Artifacts.
- Keep schema migrations additive. Define compatibility with older clients before changing required GitHub-only fields. Publish matching TypeScript/Rust schemas, fixtures, and minimum-client behavior.
- Start with linking existing Artifacts repositories, then add repository creation and imports through explicit owner actions. Handle incomplete imports and retriable conflicts.
- Preserve commit-author behavior explicitly. Decide whether Artifacts uses the current GitHub identity or a separately configured author.
- Use a project namespace separate from `tempo-agents` and the execution-definition namespace. Namespace names are a spec decision.
- Keep provider errors distinct from the existing custom-agent storage error message. Define exact new error contracts during the spec phase.

GitHub repository access, PRs, checks, and merge continue through the GitHub adapter. Supporting Artifacts hosting does not remove Better Auth's current GitHub sign-in or `TEMPO_OWNER_GITHUB_ID`; removing that dependency is a separate decision.

## Trusted branch publication

Agent containers get read access to the canonical Artifacts remote through `TempoOutbound`. Match the exact account, namespace, repository, and HTTPS path. Keep tokens out of remote URLs, process environments, files, events, logs, and backups. Mint short-lived tokens in trusted code and revoke them when the operation ends. Prevent credential forwarding across redirects or to another remote.

The proposed Artifacts Commit and Push operation is:

1. `tempod` prepares the user's commit and a Git bundle using its local repository.
2. WorkspaceDO persists publication intent: expected branch commit, intended new commit, bundle identity, and operation identity.
3. The publisher validates size, objects, expected commit, and permitted refs. It imports objects without executing repository code or hooks. It resolves the target branch from WorkspaceDO state, not an arbitrary request argument.
4. It updates only that workspace branch, conditioned on the expected remote commit. Any supported revert/force operation needs its own explicit policy and expected-SHA proof.
5. It reads the remote to confirm success, then returns evidence to WorkspaceDO. A retry first checks whether the intended commit was already published.
6. WorkspaceDO records the result and emits its normal workspace updates. Push events independently start CI; reconcile when an event is missing.

Direct terminal or agent `git push` to Artifacts would be blocked. This is a proposed behavior change, not an existing rule. Decide whether to expose the trusted publish action through the Tempo MCP server as well as the clients.

Do not replace this boundary with a generic authenticated Git proxy. A repository-wide write token injected into `git-receive-pack` would let agent code update the base branch and bypass review. A ref-filtering Git relay is an alternative only after its packet parsing and authorization are qualified.

## Reviews, checks, and safe merge

Artifacts reviews are Tempo records, with stable Tempo links and comments tied to commits. They must not be stored as fake GitHub PR numbers. Keep their durable history at repository scope so deleting an archived workspace does not erase a review or merge record. Define repository unlink/deletion, retention, and orphan-review behavior explicitly.

Each review records the exact head and base commits, title/body, review state, comments, required check policy, and merge evidence. Reuse the existing diff and guided review surfaces where possible. A repository guide remains untrusted content and follows the current artifact rendering rules.

The recommended initial merge method is squash, matching Tempo's current default. Other methods need explicit spec decisions.

1. Persist the merge intent and expected head/base commits before acting.
2. Prepare an immutable merge candidate in isolated execution. Define a candidate ref convention and qualify it against Artifacts and push events.
3. Run required checks against that candidate's exact SHA and approved pipeline revision.
4. Require owner approval of the current review/candidate. A changed head, changed base, or changed required-check policy invalidates the relevant evidence and requires a new candidate/check run.
5. Serialize repository merge intent and condition the final base update on its expected old SHA. Repository serialization alone does not protect against an external push.
6. After an uncertain reply, inspect the remote and recover the recorded operation. Do not create another squash commit on each retry.
7. Record the merged commit and review state, then apply the specified archive behavior through WorkspaceDO.

Check state belongs to a commit and run, independent of a PR number. Empty, unknown, incomplete, cancelled, or stale required results cannot grant merge permission. The trusted runner records process results; pipeline code cannot declare required checks successful or directly mark a review merged.

Keep publisher rights separate from CI runner rights. An owner with external repository write credentials can still make external changes; Tempo must detect those changes and invalidate stale evidence. Tempo's review gate is not a claim of native Artifacts branch protection.

## Per-user execution repositories and runtime releases

Recommend one private Artifacts execution repo per owner. Store Dockerfiles, dependency/version manifests, declarative pipelines, lockfiles, and a generated CI Worker wrapper there. Store image layers in Cloudflare Registry, never in the Git repo. Store no credentials in either source files or image layers.

Example layout, with proposed names:

```text
profiles/
  python/
    workspace.Dockerfile
    ci.Dockerfile
    versions.json
    pipeline.yaml
ci/
  cloudflare.ci.ts
  wrangler.jsonc
bun.lock
```

`cloudflare.ci.ts` is generated integration code using the pinned engine. A file in the owner's editable repo is not trusted merely because Tempo generated it once. Before deployment, the trusted publisher regenerates the wrapper and configuration from the pinned Tempo template, or verifies their exact hashes against that template and the approved declarative inputs. It rejects repository changes to Worker bindings, entrypoints, plugins, deployment targets, and other privileged configuration. Stored generated files are inspectable copies, not a source of deployment authority.

Optional user-authored JS/TS is loaded separately in a Dynamic Worker; it must never become an import of the trusted CI Worker. Bundle it through a controlled compiler and bounded module graph, without executing repository package scripts, compiler plugins, or config hooks in a credentialed process. Custom images can be supported entirely through declarative configuration.

Use separate immutable runtime-release records. Existing named Environments govern egress and secrets and can refresh live; an image/profile file must not select a secret scope. Owner-controlled project settings select workspace and CI releases. Define any workspace override separately.

A release records at least:

- Owner and execution repository identity; recipe commit and build-context digest.
- Workspace and CI image digests and registered image keys.
- Base-image digests, target platform, and pinned dependency versions.
- Tempo runtime/protocol version, Sandbox SDK/shim version, CI engine version, and pipeline revision.
- Generated-wrapper/deployment version, policy revision, validation evidence, and publication state.

Workspace images initially extend a pinned Tempo base and preserve `tempod`, the required adapters/tools, uid/gid, paths, health/connect protocol, checkpoint behavior, and entrypoint rules. They must not make outbound requests before `hello`. The SDK/shim versions must match. CI images need only their chosen build tools and the Sandbox 1.0 helper/runtime contract. Validate both on `linux/amd64`.

Every custom dependency version must be pinned in its version manifest. Approve and pin additions to Tempo's stack before installation. Do not use devcontainers as an implicit replacement for this release model.

## Image publication and lifecycle

Image publication and application CI are independent flows:

```text
Execution repo revision -> isolated image build -> validation -> registry digest
  -> image registration deployment -> owner activation -> immutable runtime release

Project branch push -> approved runtime release -> validated CI plan
  -> isolated CI jobs -> trusted check results -> review and merge
```

Use Workers Builds or a trusted Docker-capable builder for image recipes. Tempo currently excludes Docker inside workspace containers; do not add it silently. Qualify managed build isolation before using it: untrusted build commands and Dockerfile instructions must not receive Wrangler, registry-publication, or deployment credentials, a privileged host socket, or another owner's build context. Keep build output and publication as separate capabilities. If the selected service cannot enforce this, use a builder that can.

Build and validate before updating an active Worker image map. Worker/image deployment is not transactional, so use staged publication, verify both image registration and container startup, and activate the release only after success. Reconcile partial publication and do not rotate or replace the existing Tempo deployment/state-store secrets.

For today's self-hosted architecture, workspace images are registered on the owner's Tempo Worker because WorkspaceDO owns `ctx.container`. CI images are registered on a separate owner CI Worker. Moving workspace execution to a separate runtime service would require an explicit ownership/spec change. A future hosted design can use owner runner deployments or shards after defining that boundary.

- Adding a named image requires deployment. The documented runtime API uses registered images, not arbitrary user-supplied URLs.
- Keep old registered image keys while live workspaces, CI jobs, snapshots, or rollback releases refer to them. The 100-name map and the default 50 GB account image-storage limit require quotas and reference-aware cleanup. [Container limits](https://developers.cloudflare.com/containers/platform/limits/)
- Record the actual selected image digest when a container starts. Use that record for snapshots; never relabel an old running container with the latest deployment map's image.
- Keep running and sleeping workspaces pinned to their selected release. Updating a profile does not upgrade them automatically.
- Upgrade explicitly after a successful safety checkpoint and backup. Start the new image, apply the checkpoint, restore permitted home files, run setup/compatibility checks, and preserve recovery references if validation fails. Check that restored home files do not overwrite new runtime defaults.
- Restore a container snapshot only with its original image release. Cloudflare snapshots are image-specific. [Snapshot compatibility](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)
- Include the selected image/runtime release in model-discovery cache identity and adapter compatibility checks. The current discovery path also assumes the single workspace image.

The current spec invalidates snapshots globally on image changes. Replace that policy explicitly with release-specific compatibility during implementation; this plan does not silently change it.

## CI execution, results, and caches

After the SDK compatibility gate, use a trusted CI Worker and Workflows to validate and execute project pipelines. The repository coordinator holds bounded review/check history; keep bulk sanitized logs and permitted outputs in R2 with owner-authenticated access and retention limits. WorkspaceDO alone updates workspace summaries.

- Take the checkout SHA from validated push metadata or trusted review state, not from the pipeline's claimed source. Validate the immutable repository ID and ignore ref-deletion events as build requests.
- Required checks and pipeline selection come from owner-approved settings/revisions, so a feature branch cannot remove its own merge requirements.
- Bound event deduplication by repository, ref, commit, pipeline revision, and attempt. An intentional rerun gets a distinct attempt. Reconcile missed events with remote state.
- Each run records project SHA, runtime release, execution-repo commit, image digest, engine/pipeline revision, policy revision, attempt, and trusted job results. Reject stale or mismatched completion messages.
- Start with owner-configured commands rather than assuming every project uses Bun. For a Bun pipeline, frozen install can feed independent lint/typecheck/test/build jobs through a verified dependency cache.
- Enforce jobs, parallelism, CPU/memory/disk, wall time, output size, retention, and cost limits in the trusted coordinator. Define exact limits in the spec.
- On expiry or cancellation, reject further work, stop owned containers, and reconcile outstanding operations. A parent timeout alone does not cancel a job.
- All external side effects must be idempotent. Keep application deployment as a distinct, owner-authorized action with explicit target and artifact identity.
- Cache identity includes owner/project/repository, platform, image digest, recipe/pipeline/engine revision, relevant manifests, and lockfiles. No cross-owner cache sharing by default.
- Prefer declared dependency/output caches restored onto a clean checkout. Disable the SDK's whole-source overlay reuse until deletion, branch changes, credential exclusion, and derived-output correctness are proved.
- Prevent privileged credentials from entering untrusted execution. Redact log content before storage or return; the field-name redact helper alone is not a raw-output sanitizer. Sanitize errors and validate output paths, file types, and sizes using the existing artifact/preview security model.

## Safe custom pipeline code

Use declarative YAML first. Validate it as data with bounded size, fields, step count, dependencies, commands, and approved image-release references.

Optional custom JS/TS is a planner loaded from an immutable execution-repo revision into a Dynamic Worker. It receives bounded source metadata and returns a bounded pipeline plan. The trusted Worker validates that plan before it admits any jobs.

The Dynamic Worker configuration must explicitly set `globalOutbound: null`; omission can inherit network access. Give it no raw secrets, Artifacts binding, R2/D1 binding, Durable Object namespace, container binding, publisher, or full SDK environment. Set CPU and subrequest limits and enforce a host deadline/output cap. Key `LOADER.get()` by owner plus immutable code/configuration hash and policy revision, not by mutable owner-only `latest`. [Loader API](https://developers.cloudflare.com/dynamic-workers/api-reference/)

If live decisions between jobs are later required, expose narrow capabilities such as job submission and result reading. Bind owner, repository, run, source SHA, and approved releases in trusted server context. User code can request a bounded command; it cannot select another owner, choose arbitrary resources, alter required-check policy, self-report trusted success, merge, or deploy. Check quotas and run expiry on every RPC. Avoid generic authenticated URL forwarding or arbitrary deployment targets.

Dynamic Workflows is a later option for durable custom control flow. It uses an additional library that must be approved, pinned, and qualified. Persist immutable code/release/policy identity with each run and resume that same identity. Tenant metadata tagging is not authorization; do not trust a caller's tenant header. Store no secrets in metadata or step results. [Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/)

Code review and scans can find faults, but safe execution depends on these runtime boundaries. Test malicious inputs that attempt cross-owner access, unrestricted network calls, secret requests, excessive jobs, false check results, altered refs, and unauthorized publication.

## Clients, events, and spec changes

Web and Mac changes ship in the same phase. Add provider selection, Artifacts repository setup, runtime release selection/publication state, Tempo review links, branch checks without a PR, CI logs/retry/cancel, merge-candidate state, and clear failures. Preserve phone behavior and the Mac client's existing browser policy for HTML/preview content.

Archive and restore use provider-aware branch operations. Define how open Tempo reviews affect branch deletion and how restored branches recover from checkpoints. Workspace deletion preserves repository history. Review links remain meaningful while a workspace sleeps or has been deleted.

Update the existing role/check event contracts and deduplication keys, which currently use `prNumber`. Scope them to provider/repository/commit/run so native checks work without a GitHub PR. Do not let repeated CI notifications trigger duplicate role runs.

| Spec tab | Required decisions/changes |
| --- | --- |
| 00 Overview | Repository vocabulary, second provider, new components, custom runtime releases, revised non-goals and stack. |
| 01 Runtime and Agents | Image contracts, provider clone/publish path, credential/egress rules, CI runners, execution definitions, model discovery. |
| 02 Data and API | Provider identity, review/check/release records, ownership, APIs, schemas, errors, and client compatibility. |
| 03 Lifecycles | Idempotent publish/merge/publication/upgrade operations, retries, candidate checks, archive/restore/delete, cancellation. |
| 04 UI | Provider/project setup, runtime releases, CI and Tempo reviews, actions, empty/error states, phone layouts. |
| 05 Security and Ops | Capability boundaries, isolated builds, secrets, output handling, image registration, quotas, retention, upgrades and rollback. |
| 06 Build Plan | Milestones, platform spikes, gates, dependencies, required evidence, and tests. |
| 07 Mac Client | Matching controls/contracts in each web phase and native acceptance. |
| 08 Events and Roles | Provider-neutral check/review events, SHA identity, deduplication and role-trigger policy. |

Record deviations and remaining decisions in `IMPLEMENTATION_NOTES.md` during implementation. Do not treat this plan as an exception to Sandbox 1.0, ACP v1, pinned dependencies, secrecy, or WorkspaceDO ownership.

## Delivery sequence

Each stage should be a focused PR or small PR group with explicit acceptance evidence. Do not expose incomplete capabilities as supported features.

| Stage | Deliverable | Exit gate |
| --- | --- | --- |
| 1. Spec and platform qualification | Exact contracts/policies; current SDK/API review; Artifacts Git and image/CI spikes | Expected-SHA updates, empty-repo push, candidate refs, deletion, credentials, Sandbox 1.0 execution, image registration, and build isolation proved. |
| 2. Runtime releases and runner seam | Immutable default/custom image releases, digest accounting, deployment registration and Sandbox 1.0 compatible SDK integration | Default and sample custom workspace/CI images pass runtime tests; snapshot and model-discovery behavior matches the selected release. |
| 3. Provider substrate and trusted publishing | Additive migration, repository connection, clone/recovery, bundle publisher and provider-aware archive | Both providers pass conformance; no container can use Tempo credentials to write an Artifacts base branch directly. |
| 4. Execution repository and image publication | Per-owner source repo, generated wrapper, candidate builds, isolated publication, owner activation and rollback | Interrupted publication recovers; running/sleeping workspaces keep their release; no build credentials enter source, images, logs or backups. |
| 5. Declarative project CI | Push ingestion, bounded plans/jobs, exact-SHA results, caches, logs and lifecycle events | Duplicate/missed events reconcile, cancelled/stale jobs cannot grant success, cached runs match clean runs, and web/Mac checks work without a PR. |
| 6. Tempo reviews and merge | Repository history, guided review, candidate checks, squash merge, recovery and client flows | Concurrent/external pushes fail safely; history survives workspace deletion; each approved merge matches checked candidate evidence. |
| 7. Optional programmable planning | Dynamic Worker plan evaluator and narrow capabilities | Malicious code cannot escape its owner/run scope or policy limits. Qualify Dynamic Workflows separately if needed. |

Stages 2 and 3 can proceed independently after their contracts are fixed. Stage 4 depends on release and publication contracts. Reviews can be developed alongside CI, but the first supported Artifacts release includes both review and merge as the owner requested. Every visible stage includes both clients.

## Acceptance and evidence

Acceptance requires real platform evidence as well as local tests. Mocks, a created PR, a successful deploy command, and assistant narration do not prove the feature works.

| Area | Required cases |
| --- | --- |
| Providers | Existing GitHub project migration; Artifacts empty/create/link/import; names reused with a new repository ID; large-object limits; clone without Git filter support. |
| Git writes | Bundle/ref validation; branch restriction; expected-SHA rejection; concurrent updates; lost push acknowledgement; safe revert/force policy; branch deletion and checkpoint recreation. |
| Reviews | Head/base/policy changes; unknown or missing checks; failed/cancelled/stale checks; concurrent merges; lost merge acknowledgement; comments/guide freshness; workspace deletion and repository retention. |
| CI | Duplicate/delayed/missed/deletion events; exact checkout/candidate SHA; retries and intentional reruns; process/container loss; cancelled runs; required-check policy tampering; budget and output limits. |
| Cache | Deleted source, changed branch, changed image/engine/pipeline, changed lockfiles; clean vs cached output; cross-owner reads; credential/path exclusion. |
| Images | Default/custom workspace and CI contracts; shim/runtime versions; no pre-hello outbound; partial publication; registration readiness; failed upgrade; home restore; release-specific snapshots; rollback and reference-aware cleanup. |
| Dynamic code | Blocked network; missing privileged bindings; cross-owner/run arguments; infinite loops/waits; too many jobs; false status; mutable code/config on retry; oversized outputs; expired/cancelled capability use. |
| Secrets and files | New Git, registry, deployment, and API credentials absent from untrusted process/start env, source, images, logs/errors/events, metadata and backups; restricted credentialed operations; redirect handling; untrusted output paths/types/previews. Preserve the spec's existing `TEMPOD_TOKEN`, Claude login, Codex auth.json/snapshot, and owner-declared unscoped-secret exceptions. |
| Clients and roles | Web/Mac parity, phone layout, sleeping/archived/deleted review reads, provider-aware links/actions, CI without PR numbers, reconnect/replay, and no duplicate role dispatch. |

For implementation PRs, run `bun run typecheck`, `bun run lint`, and `bun run test` from the root, plus formatting/version checks and affected builds. Every changed server function, operation step, and daemon request needs tests. DO tests use the specified Cloudflare Worker pool. Daemon tests run inside the full container image. Add native and browser acceptance for affected flows. Read installed Turbo docs before changing orchestration.

For hosted gates, record source SHA, runtime/pipeline release, deployed Worker version, actual image digest, run IDs, commands/results, retained evidence, and unresolved limitations. Select accounts and run deployments, paid checks, or evaluations only with explicit authorization. This documentation PR performs no such actions.

## Decisions still required before implementation

- Exact provider, repository coordinator, review, runtime-release, and check schemas/APIs; additive client compatibility.
- Artifacts namespace names, repository provisioning, private migration, author identity, and unlink/deletion retention.
- Trusted publishing UX/MCP access and direct-push restriction; any force/revert policy.
- Review state/approval rules, candidate refs, initial squash-only support versus other merge methods, required-check policy and external-change recovery.
- Release selection/overrides, image compatibility tests, supported custom bases, publication/activation approval, rollback and upgrade behavior.
- Builder choice and proof of build/publication isolation; automated Artifacts-to-Builds provisioning support.
- Exact CI commands, retries, quotas, resource limits, cost ceilings, output limits, cache paths and retention.
- The compatible pinned CI SDK release or reviewed patch, its new dependencies, and the image-selection adapter.
- Whether optional JS planners ship after the declarative release; whether adaptive capabilities or Dynamic Workflows are needed.
- Whether removing GitHub sign-in is a later feature. It is not included here.

Do not fill these gaps with implementation guesses. Complete the agreed independent work, then resolve each remaining spec decision with the owner.
