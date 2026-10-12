import { Schema } from "effect";
import {
  Injector,
  SecretBinding,
  type EgressPolicy,
  type Environment,
  type Injector as InjectorT,
  type SecretBinding as SecretBindingT,
} from "@tempo/protocol";
import type { EnvironmentRow } from "../db/d1.ts";

/** The parsed, non-secret fields of a D1 environments row (01, Environments). */
export interface EnvironmentConfig {
  readonly id: string;
  readonly name: string;
  readonly egressPolicy: EgressPolicy;
  readonly egressAllowlist: ReadonlyArray<string>;
  readonly secrets: ReadonlyArray<SecretBindingT>;
  readonly injectors: ReadonlyArray<InjectorT>;
}

const decodeSecrets = Schema.decodeUnknownOption(Schema.Array(SecretBinding));
const decodeInjectors = Schema.decodeUnknownOption(Schema.Array(Injector));
const decodeHosts = Schema.decodeUnknownOption(Schema.Array(Schema.String));

const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
};

const orEmpty = <T>(o: { _tag: "Some"; value: ReadonlyArray<T> } | { _tag: "None" }): ReadonlyArray<T> =>
  o._tag === "Some" ? o.value : [];

export const parseEnvironment = (row: EnvironmentRow): EnvironmentConfig => ({
  id: row.id,
  name: row.name,
  egressPolicy: row.egressPolicy,
  egressAllowlist: orEmpty(decodeHosts(json(row.egressAllowlistJson))),
  secrets: orEmpty(decodeSecrets(json(row.secretsJson))),
  injectors: orEmpty(decodeInjectors(json(row.injectorsJson))),
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
