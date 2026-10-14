import {
  ENVIRONMENT_LIMITS,
  EnvName,
  EnvironmentName,
  InjectorName,
  applyProposal,
  duplicateNames,
  isHostPattern,
  type EgressPolicy,
  type Environment,
  type EnvironmentProposal,
  type FnInput,
  type FnName,
  type FnOutput,
  type InjectorInput,
  type Project,
  type SecretBinding,
} from "@tempo/protocol";
import { Schema } from "effect";
import type { ConfirmOptions } from "~/ui/state/workspace-ui";
import { nextRowKey } from "./settings-model";

/**
 * Named environments (04, Settings → Environments; 01, Environments). Secret values are write-only:
 * the form holds a value only until it is sent, and nothing here reads one back.
 */

export interface SecretRow {
  /** React key; not saved. */
  readonly key: number;
  readonly name: string;
  /** Comma separated host patterns. */
  readonly hosts: string;
  /** Whether a value is stored. */
  readonly set: boolean;
  /** A new value to send with setEnvironmentSecret; empty means keep. */
  readonly value: string;
  /** Added in this form; only new rows can be named, since a rename would drop the value. */
  readonly isNew: boolean;
}

export interface InjectorRow {
  readonly key: number;
  readonly name: string;
  readonly hosts: string;
  readonly code: string;
}

export interface EnvironmentForm {
  readonly name: string;
  readonly egressPolicy: EgressPolicy;
  /** One pattern per line. */
  readonly allowlist: string;
  readonly secrets: ReadonlyArray<SecretRow>;
  readonly injectors: ReadonlyArray<InjectorRow>;
}

export interface EnvironmentUpdate {
  readonly name: string;
  readonly egressPolicy: EgressPolicy;
  readonly egressAllowlist: string[];
  readonly secrets: SecretBinding[];
  readonly injectors: InjectorInput[];
}

export interface SecretValue {
  readonly name: string;
  readonly value: string;
}

export type FormErrors = Partial<Record<"name" | "allowlist" | "secrets" | "injectors", string>>;

export const EGRESS_POLICY_OPTIONS: ReadonlyArray<{ value: EgressPolicy; label: string }> = [
  { value: "allowlist", label: "Allowlist" },
  { value: "open", label: "Open" },
];

export const policyLabel = (p: EgressPolicy): string =>
  EGRESS_POLICY_OPTIONS.find((o) => o.value === p)?.label ?? p;

const isEnvName = Schema.is(EnvName);

const isEnvironmentName = Schema.is(EnvironmentName);

const isInjectorName = Schema.is(InjectorName);

export const formFromEnvironment = (env: Environment): EnvironmentForm => ({
  name: env.name,
  egressPolicy: env.egressPolicy,
  allowlist: env.egressAllowlist.join("\n"),
  secrets: env.secrets.map((s) => ({
    key: nextRowKey(),
    name: s.name,
    hosts: s.hosts.join(", "),
    set: s.set,
    value: "",
    isNew: false,
  })),
  injectors: env.injectors.map((i) => ({
    key: nextRowKey(),
    name: i.name,
    hosts: i.hosts.join(", "),
    code: i.code,
  })),
});

export const emptySecretRow = (): SecretRow => ({
  key: nextRowKey(),
  name: "",
  hosts: "",
  set: false,
  value: "",
  isNew: true,
});

export const emptyInjectorRow = (): InjectorRow => ({ key: nextRowKey(), name: "", hosts: "", code: "" });

/** Host patterns from text: split on newlines and commas, trimmed, lower case, no blanks. */
export const parseHosts = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");

const badHost = (hosts: ReadonlyArray<string>): string | undefined => hosts.find((h) => !isHostPattern(h));

/** The updateEnvironment input and the values to send, or what is not valid. */
export const updateFromForm = (
  form: EnvironmentForm,
):
  | { readonly ok: true; readonly update: EnvironmentUpdate; readonly values: SecretValue[] }
  | { readonly ok: false; readonly errors: FormErrors } => {
  const errors: FormErrors = {};
  const name = form.name.trim();

  if (!isEnvironmentName(name)) errors.name = `Use 1 to ${ENVIRONMENT_LIMITS.nameMax} characters.`;

  const egressAllowlist = [...new Set(parseHosts(form.allowlist))];
  const bad = badHost(egressAllowlist);

  if (bad !== undefined) errors.allowlist = `Not a host pattern: ${bad}`;
  else if (egressAllowlist.length > ENVIRONMENT_LIMITS.allowlistMax)
    errors.allowlist = `Use at most ${ENVIRONMENT_LIMITS.allowlistMax} patterns.`;

  const secrets = form.secrets.map((r) => ({ name: r.name.trim(), hosts: parseHosts(r.hosts) }));
  const secretsProblem = secretsError(secrets);

  if (secretsProblem !== undefined) errors.secrets = secretsProblem;

  const injectors = form.injectors.map((r) => ({
    name: r.name.trim(),
    hosts: parseHosts(r.hosts),
    code: r.code,
  }));

  const injectorsProblem = injectorsError(injectors);

  if (injectorsProblem !== undefined) errors.injectors = injectorsProblem;

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const values = form.secrets
    .filter((r) => r.value !== "")
    .map((r) => ({ name: r.name.trim(), value: r.value }));

  return {
    ok: true,
    update: { name, egressPolicy: form.egressPolicy, egressAllowlist, secrets, injectors },
    values,
  };
};

const secretsError = (secrets: ReadonlyArray<SecretBinding>): string | undefined => {
  if (secrets.length > ENVIRONMENT_LIMITS.secretsMax)
    return `Use at most ${ENVIRONMENT_LIMITS.secretsMax} secrets.`;

  for (const s of secrets) {
    if (!isEnvName(s.name))
      return `${s.name || "A secret"}: use capital letters, digits and _, starting with a letter or _.`;
    const bad = badHost(s.hosts);

    if (bad !== undefined) return `${s.name}: not a host pattern: ${bad}`;

    if (s.hosts.length > ENVIRONMENT_LIMITS.secretHostsMax)
      return `${s.name}: use at most ${ENVIRONMENT_LIMITS.secretHostsMax} hosts.`;
  }

  const dup = duplicateNames(secrets)[0];

  return dup === undefined ? undefined : `Two secrets are named ${dup}.`;
};

const injectorsError = (injectors: ReadonlyArray<InjectorInput>): string | undefined => {
  if (injectors.length > ENVIRONMENT_LIMITS.injectorsMax)
    return `Use at most ${ENVIRONMENT_LIMITS.injectorsMax} injectors.`;

  for (const i of injectors) {
    if (!isInjectorName(i.name))
      return `${i.name || "An injector"}: use lower case letters, digits and -, starting with a letter, at most 32.`;
    const bad = badHost(i.hosts);

    if (bad !== undefined) return `${i.name}: not a host pattern: ${bad}`;

    if (i.hosts.length < 1 || i.hosts.length > ENVIRONMENT_LIMITS.injectorHostsMax)
      return `${i.name}: use 1 to ${ENVIRONMENT_LIMITS.injectorHostsMax} hosts.`;

    if (i.code.trim() === "") return `${i.name}: add the code.`;

    if (new TextEncoder().encode(i.code).length > ENVIRONMENT_LIMITS.injectorCodeMaxBytes)
      return `${i.name}: code is over 64 KiB.`;
  }

  const dup = duplicateNames(injectors)[0];

  return dup === undefined ? undefined : `Two injectors are named ${dup}.`;
};

/** The form without row keys, to tell whether it changed. */
export const formSignature = (form: EnvironmentForm): string =>
  JSON.stringify({
    ...form,
    secrets: form.secrets.map((r) => ({ ...r, key: 0 })),
    injectors: form.injectors.map((r) => ({ ...r, key: 0 })),
  });

/** 04: a secret with no hosts is visible to the agent; one with hosts is swapped in by Tempo. */
export const secretHint = (
  name: string,
  hostsText: string,
): { readonly tone: "warning" | "muted"; readonly text: string } => {
  const hosts = parseHosts(hostsText);

  return hosts.length === 0
    ? { tone: "warning", text: "Visible to the agent" }
    : {
        tone: "muted",
        text: `Use $${name.trim() || "<NAME>"} in the app; Tempo adds the value for ${hosts.join(", ")}`,
      };
};

export const deleteEnvironmentConfirm = (name: string): ConfirmOptions => ({
  title: `Delete environment ${name}?`,
  description: "Projects that use it will use none.",
  confirmLabel: "Delete",
  destructive: true,
});

/** `base`, else `base 2`, `base 3`, … whichever no environment uses yet. */
export const uniqueEnvironmentName = (base: string, taken: ReadonlyArray<string>): string => {
  const used = new Set(taken);
  const root = base.trim().slice(0, ENVIRONMENT_LIMITS.nameMax) || "Environment";

  if (!used.has(root)) return root;

  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const name = `${root.slice(0, ENVIRONMENT_LIMITS.nameMax - suffix.length).trimEnd()}${suffix}`;

    if (!used.has(name)) return name;
  }
};

/** An environment by id, or null when the id is null or no longer exists (01). */
export const findEnvironment = (
  envs: ReadonlyArray<Environment> | undefined,
  id: string | null | undefined,
): Environment | null => (id ? (envs?.find((e) => e.id === id) ?? null) : null);

/** 01, Which environment applies: the workspace's override, else the project's, else none. */
export const effectiveEnvironment = (
  envs: ReadonlyArray<Environment> | undefined,
  workspaceEnvironmentId: string | null | undefined,
  project: Pick<Project, "environmentId"> | undefined,
): Environment | null => findEnvironment(envs, workspaceEnvironmentId ?? project?.environmentId ?? null);

// Select values. Radix Select items cannot use the empty string.
export const NONE = "__none__";

export const PROJECT_DEFAULT = "__project__";

export const projectDefaultLabel = (projectEnv: Environment | null): string =>
  `Project default (${projectEnv?.name ?? "None"})`;

// Agent proposals (04, Pending environment proposals).

export interface ProposalSecretLine {
  readonly name: string;
  readonly hosts: ReadonlyArray<string>;
  /** True for a new secret or one with no stored value: the dialog asks for a value. */
  readonly needsValue: boolean;
}

export const proposalSecrets = (
  proposal: EnvironmentProposal,
  target: Environment | null,
): ProposalSecretLine[] =>
  (proposal.secrets ?? []).map((s) => {
    const current = target?.secrets.find((x) => x.name === s.name);

    return { name: s.name, hosts: s.hosts, needsValue: !current?.set };
  });

export const proposalTargetText = (target: Environment | null, repoName: string): string =>
  target ? `Apply to ${target.name}` : `Create environment ${repoName} and use it for this project`;

export const INJECTOR_WARNING = "Injectors run with access to these secrets. Read the code before you apply.";

/** The server-function calls an apply makes, through `call` so tests can fake it. */
export type Caller = <K extends FnName>(name: K, input: FnInput<K>) => Promise<FnOutput<K>>;

export interface ApplyInput {
  readonly workspaceId: string;
  readonly proposalId: string;
  readonly proposal: EnvironmentProposal;
  readonly project: Pick<Project, "id" | "name">;
  /** The effective environment, or null to create one for the project. */
  readonly target: Environment | null;
  /** Every environment, to pick a free name. */
  readonly environments: ReadonlyArray<Environment>;
  /** Values typed in the dialog, by secret name. Empty ones are skipped. */
  readonly values: Readonly<Record<string, string>>;
}

/**
 * 04, Apply: createEnvironment and setProjectEnvironment when there is no environment, then
 * updateEnvironment, setEnvironmentSecret per filled value, then resolveEnvironmentProposal.
 */
export const applyEnvironmentProposal = async (call: Caller, input: ApplyInput): Promise<Environment> => {
  let target = input.target;

  if (!target) {
    const name = uniqueEnvironmentName(
      input.project.name,
      input.environments.map((e) => e.name),
    );

    target = await call("createEnvironment", { name });
    await call("setProjectEnvironment", { projectId: input.project.id, environmentId: target.id });
  }

  const next = applyProposal(target, input.proposal);
  const updated = await call("updateEnvironment", { environmentId: target.id, ...next });

  for (const s of input.proposal.secrets ?? []) {
    const value = input.values[s.name];

    if (value) await call("setEnvironmentSecret", { environmentId: target.id, name: s.name, value });
  }

  await call("resolveEnvironmentProposal", {
    workspaceId: input.workspaceId,
    proposalId: input.proposalId,
    status: "applied",
  });

  return updated;
};
