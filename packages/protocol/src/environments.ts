import { Schema } from "effect";
import { EgressPolicy } from "./enums.ts";
import { EnvName, HostPattern } from "./settings.ts";

/** Named environments (01, Environments). */

export const ENVIRONMENT_LIMITS = {
  nameMax: 64,
  allowlistMax: 200,
  secretsMax: 50,
  secretHostsMax: 20,
  injectorsMax: 10,
  injectorHostsMax: 20,
  injectorCodeMaxBytes: 64 * 1024,
  noteMax: 2000,
  pendingProposalsMax: 20,
} as const;

export const SECRET_PLACEHOLDER_PREFIX = "tempo-secret-";
export const SECRET_PLACEHOLDER_RE = /tempo-secret-([A-Z_][A-Z0-9_]*)/g;
export const secretPlaceholder = (name: string): string => `${SECRET_PLACEHOLDER_PREFIX}${name}`;

/** A host or `*.` plus a host, lower case, no port (02, Environments). */
export const isHostPattern = (p: string): boolean => Schema.is(HostPattern)(p);

export const InjectorName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/));
export const EnvironmentName = Schema.String.check(
  Schema.isBetweenLength(1, ENVIRONMENT_LIMITS.nameMax),
  Schema.isPattern(/^\S(.*\S)?$/),
);

export const SecretBinding = Schema.Struct({
  name: EnvName,
  hosts: Schema.Array(HostPattern).check(Schema.isMaxLength(ENVIRONMENT_LIMITS.secretHostsMax)),
});
export type SecretBinding = typeof SecretBinding.Type;

export const InjectorCode = Schema.String.check(
  Schema.makeFilter(
    (s: string) =>
      (s.trim().length > 0 &&
        new TextEncoder().encode(s).length <= ENVIRONMENT_LIMITS.injectorCodeMaxBytes) ||
      "injector code must be 1 byte to 64 KiB",
  ),
);

export const InjectorInput = Schema.Struct({
  name: InjectorName,
  hosts: Schema.Array(HostPattern).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(ENVIRONMENT_LIMITS.injectorHostsMax),
  ),
  code: InjectorCode,
});
export type InjectorInput = typeof InjectorInput.Type;

export const Injector = Schema.Struct({ ...InjectorInput.fields, sha256: Schema.String });
export type Injector = typeof Injector.Type;

export const EnvironmentSecret = Schema.Struct({ ...SecretBinding.fields, set: Schema.Boolean });
export type EnvironmentSecret = typeof EnvironmentSecret.Type;

export const Environment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  egressPolicy: EgressPolicy,
  egressAllowlist: Schema.Array(Schema.String),
  secrets: Schema.Array(EnvironmentSecret),
  injectors: Schema.Array(Injector),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type Environment = typeof Environment.Type;

export const EgressAllowlist = Schema.Array(HostPattern).check(
  Schema.isMaxLength(ENVIRONMENT_LIMITS.allowlistMax),
);
export const SecretBindings = Schema.Array(SecretBinding).check(
  Schema.isMaxLength(ENVIRONMENT_LIMITS.secretsMax),
);
export const InjectorInputs = Schema.Array(InjectorInput).check(
  Schema.isMaxLength(ENVIRONMENT_LIMITS.injectorsMax),
);

export const EnvironmentProposal = Schema.Struct({
  note: Schema.String.check(Schema.isMaxLength(ENVIRONMENT_LIMITS.noteMax)),
  egressPolicy: Schema.optional(EgressPolicy),
  allowlistAdd: Schema.optional(EgressAllowlist),
  secrets: Schema.optional(SecretBindings),
  injectors: Schema.optional(InjectorInputs),
});
export type EnvironmentProposal = typeof EnvironmentProposal.Type;

export const PendingEnvironmentProposal = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.Number,
  proposal: EnvironmentProposal,
});
export type PendingEnvironmentProposal = typeof PendingEnvironmentProposal.Type;

/** What the agent may see about its environment (01, Environments): never a secret value. */
export const EnvironmentSummary = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  egressPolicy: EgressPolicy,
  egressAllowlist: Schema.Array(Schema.String),
  secrets: Schema.Array(EnvironmentSecret),
  injectors: Schema.Array(Schema.Struct({ name: Schema.String, hosts: Schema.Array(Schema.String) })),
  blockedHosts: Schema.Array(Schema.String),
});
export type EnvironmentSummary = typeof EnvironmentSummary.Type;

/** `*.example.com` matches `a.example.com` and `b.a.example.com` but not `example.com` (05). */
export const hostMatches = (host: string, pattern: string): boolean => {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
};

export const duplicateNames = (list: ReadonlyArray<{ readonly name: string }>): string[] => {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const { name } of list) (seen.has(name) ? dup : seen).add(name);
  return [...dup];
};

/** Applies a proposal to an environment's editable fields. Proposals only add or replace (01). */
export const applyProposal = (
  base: {
    readonly egressPolicy: EgressPolicy;
    readonly egressAllowlist: ReadonlyArray<string>;
    readonly secrets: ReadonlyArray<SecretBinding>;
    readonly injectors: ReadonlyArray<InjectorInput>;
  },
  p: EnvironmentProposal,
): {
  egressPolicy: EgressPolicy;
  egressAllowlist: string[];
  secrets: SecretBinding[];
  injectors: InjectorInput[];
} => {
  const egressAllowlist = [...base.egressAllowlist];
  for (const h of p.allowlistAdd ?? []) if (!egressAllowlist.includes(h)) egressAllowlist.push(h);
  const upsert = <T extends { readonly name: string }>(
    list: ReadonlyArray<T>,
    add: ReadonlyArray<T>,
  ): T[] => {
    const out = [...list];
    for (const item of add) {
      const i = out.findIndex((x) => x.name === item.name);
      if (i >= 0) out[i] = item;
      else out.push(item);
    }
    return out;
  };
  return {
    egressPolicy: p.egressPolicy ?? base.egressPolicy,
    egressAllowlist,
    secrets: upsert(
      base.secrets.map((s) => ({ name: s.name, hosts: s.hosts })),
      p.secrets ?? [],
    ),
    injectors: upsert(
      base.injectors.map((i) => ({ name: i.name, hosts: i.hosts, code: i.code })),
      p.injectors ?? [],
    ),
  };
};
