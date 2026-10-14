import type { EgressPolicy, Environment, Injector, SecretBinding } from "@tempo/protocol";
import type { EnvironmentRow } from "../db/d1.ts";
import { json } from "../db/json.ts";

/** The parsed, non-secret fields of a D1 environments row (01, Environments). */
export interface EnvironmentConfig {
  readonly id: string;
  /** The owner; their CredentialDO holds the secrets (11, Shared project configuration). */
  readonly userId: string;
  readonly name: string;
  readonly egressPolicy: EgressPolicy;
  readonly egressAllowlist: ReadonlyArray<string>;
  readonly secrets: ReadonlyArray<SecretBinding>;
  readonly injectors: ReadonlyArray<Injector>;
}

export const parseEnvironment = (row: EnvironmentRow): EnvironmentConfig => ({
  id: row.id,
  userId: row.userId,
  name: row.name,
  egressPolicy: row.egressPolicy,
  egressAllowlist: json.egressAllowlist.read(row.egressAllowlistJson, []),
  secrets: json.environmentSecrets.read(row.secretsJson, []),
  injectors: json.environmentInjectors.read(row.injectorsJson, []),
});

export const environmentToWire = (row: EnvironmentRow, setNames: ReadonlyArray<string>): Environment => {
  const c = parseEnvironment(row);
  const set = new Set(setNames);

  return {
    id: c.id,
    name: c.name,
    egressPolicy: c.egressPolicy,
    egressAllowlist: [...c.egressAllowlist],
    secrets: c.secrets.map((s) => ({ name: s.name, hosts: [...s.hosts], set: set.has(s.name) })),
    injectors: c.injectors.map((i) => ({ ...i, hosts: [...i.hosts] })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

export const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export const environmentSecretKey = (environmentId: string, name: string): string =>
  `environment.${environmentId}.secret.${name}`;

export const environmentSecretPrefix = (environmentId: string): string =>
  `environment.${environmentId}.secret.`;
