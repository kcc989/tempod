import { Schema } from "effect";
import { DeployPermission } from "./enums.ts";

/** 14, Format: the closed `read` list. */
export const CAPABILITY_READS = [
  "repo",
  "deployments",
  "prod_errors",
  "issues",
  "pull_requests",
  "ci_runs",
] as const;

export const CapabilityRead = Schema.Literals(CAPABILITY_READS);

export type CapabilityRead = typeof CapabilityRead.Type;

/** 14, C-ADR-3: the named exceptions. */
export const MANIFEST_EXCEPTIONS = ["claude_login", "codex_login", "secrets_without_hosts"] as const;

export const ManifestException = Schema.Literals(MANIFEST_EXCEPTIONS);

export type ManifestException = typeof ManifestException.Type;

export const CapabilityCall = Schema.Struct({
  id: Schema.String,
  hosts: Schema.Array(Schema.String),
  credential: Schema.NullOr(Schema.Struct({ ref: Schema.String, placeholder: Schema.String })),
  /** Empty means every method (14, Format). */
  methods: Schema.Array(Schema.String),
  builtin: Schema.Boolean,
});

export type CapabilityCall = typeof CapabilityCall.Type;

export const CapabilityDeploy = Schema.Struct({
  target: Schema.String,
  workers: Schema.Array(Schema.String),
  cloudflare: Schema.Array(DeployPermission),
  agent: Schema.Boolean,
});

export const ManifestSessionKind = Schema.Literals(["chat", "run", "deploy", "ci"]);

/** 14: one agent session's capabilities, compiled by the WorkspaceDO and frozen for the session. */
export const CapabilityManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  projectId: Schema.String,
  revision: Schema.Number,
  sha256: Schema.String,
  session: Schema.Struct({ kind: ManifestSessionKind, access: Schema.Literals(["write", "read-only"]) }),
  stack: Schema.Struct({
    runtime: Schema.NullOr(Schema.String),
    packageManager: Schema.NullOr(Schema.String),
    frameworks: Schema.Array(Schema.String),
    libraries: Schema.Array(Schema.String),
  }),
  read: Schema.Array(CapabilityRead),
  call: Schema.Array(CapabilityCall),
  cloudflare: Schema.NullOr(
    Schema.Struct({ resources: Schema.Array(Schema.String), permissions: Schema.Array(DeployPermission) }),
  ),
  exceptions: Schema.Array(ManifestException),
  deploy: Schema.Array(CapabilityDeploy),
});

export type CapabilityManifest = typeof CapabilityManifest.Type;
