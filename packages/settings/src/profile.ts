import { TempoError, isHostPattern } from "@tempo/protocol";
import { Schema } from "effect";
import { parse as parseYaml } from "yaml";

/** 13, L-ADR-3: Exact rules. */
export const PROFILE_LIMITS = {
  sourceBytes: 32 * 1024,
  shortChars: 100,
  listItems: 30,
  services: 20,
  purposeChars: 200,
  hosts: 20,
  checks: 10,
  commandChars: 4096,
  timeoutMinutes: { min: 1, max: 30, default: 10 },
  screens: 50,
  routeChars: 200,
  globs: 20,
  notesLines: 40,
  notesBytes: 4096,
} as const;

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ProfileService {
  readonly name: string;
  readonly purpose: string;
  readonly hosts: ReadonlyArray<string>;
  readonly credential: string | null;
  readonly methods: ReadonlyArray<HttpMethod>;
}

export interface ProfileCheck {
  readonly name: string;
  readonly command: string;
  readonly timeoutMinutes: number;
}

export interface ProfileScreen {
  readonly route: string;
  readonly files: ReadonlyArray<string>;
}

export interface ProfileSpec {
  readonly stack: {
    readonly runtime: string | null;
    readonly packageManager: string | null;
    readonly frameworks: ReadonlyArray<string>;
    readonly libraries: ReadonlyArray<string>;
  };
  readonly services: ReadonlyArray<ProfileService>;
  readonly checks: ReadonlyArray<ProfileCheck>;
  readonly screens: ReadonlyArray<ProfileScreen>;
  readonly notes: string;
}

const NAME = /^[a-z][a-z0-9-]{0,39}$/;

const SECRET = /^[A-Z_][A-Z0-9_]*$/;

const invalid = (detail: string): never => {
  throw new TempoError("PROFILE_INVALID", undefined, detail);
};

const isText = Schema.is(Schema.String);

const isObj = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Schema.is(Schema.JsonObject)(value);

const onlyKeys = (value: Schema.JsonObject, allowed: ReadonlyArray<string>, path: string): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(`${path}${key}: unknown key`);
  }
};

const text = (value: Schema.Json | undefined, path: string, max: number): string => {
  if (!isText(value) || value.trim() === "" || value.length > max)
    return invalid(`${path}: 1 to ${max} characters`);

  return value;
};

const optionalText = (value: Schema.Json | undefined, path: string, max: number): string | null =>
  value === undefined ? null : text(value, path, max);

const list = (value: Schema.Json | undefined, path: string, max: number): Schema.Json[] => {
  if (value === undefined) return [];

  if (!Array.isArray(value)) return invalid(`${path}: must be a list`);

  if (value.length > max) invalid(`${path}: at most ${max}`);

  return value;
};

const textList = (value: Schema.Json | undefined, path: string, max: number, chars: number): string[] =>
  list(value, path, max).map((item, i) => text(item, `${path}[${i}]`, chars));

const unique = (names: ReadonlyArray<string>, path: string): void => {
  const seen = new Set<string>();

  for (const name of names) {
    if (seen.has(name)) invalid(`${path}: duplicate "${name}"`);
    seen.add(name);
  }
};

const parseStack = (raw: Schema.Json | undefined): ProfileSpec["stack"] => {
  if (raw === undefined) return { runtime: null, packageManager: null, frameworks: [], libraries: [] };

  if (!isObj(raw)) return invalid("stack: must be a map");
  onlyKeys(raw, ["runtime", "package_manager", "frameworks", "libraries"], "stack.");
  const { shortChars, listItems } = PROFILE_LIMITS;

  return {
    runtime: optionalText(raw["runtime"], "stack.runtime", shortChars),
    packageManager: optionalText(raw["package_manager"], "stack.package_manager", shortChars),
    frameworks: textList(raw["frameworks"], "stack.frameworks", listItems, shortChars),
    libraries: textList(raw["libraries"], "stack.libraries", listItems, shortChars),
  };
};

const parseService = (raw: Schema.Json, i: number): ProfileService => {
  const path = `services[${i}]`;

  if (!isObj(raw)) return invalid(`${path}: must be a map`);
  onlyKeys(raw, ["name", "purpose", "hosts", "credential", "methods"], `${path}.`);
  const name = text(raw["name"], `${path}.name`, 40);

  if (!NAME.test(name)) invalid(`${path}.name: use a-z, 0-9 and "-" (at most 40)`);
  const hosts = list(raw["hosts"], `${path}.hosts`, PROFILE_LIMITS.hosts);

  if (hosts.length === 0 || !hosts.every((h) => isText(h) && isHostPattern(h)))
    invalid(`${path}.hosts: 1 to ${PROFILE_LIMITS.hosts} host patterns`);
  const credential = optionalText(raw["credential"], `${path}.credential`, 100);

  if (credential !== null && !SECRET.test(credential))
    invalid(`${path}.credential: an environment secret name such as STRIPE_KEY`);
  const methods = list(raw["methods"], `${path}.methods`, HTTP_METHODS.length);
  const known = methods.filter((m): m is HttpMethod => HTTP_METHODS.some((k) => k === m));

  if (known.length !== methods.length) invalid(`${path}.methods: use ${HTTP_METHODS.join(", ")}`);

  return {
    name,
    purpose: text(raw["purpose"], `${path}.purpose`, PROFILE_LIMITS.purposeChars),
    hosts: hosts.filter(isText),
    credential,
    methods: known,
  };
};

const parseCheck = (raw: Schema.Json, i: number): ProfileCheck => {
  const path = `checks[${i}]`;

  if (!isObj(raw)) return invalid(`${path}: must be a map`);
  onlyKeys(raw, ["name", "command", "timeout_minutes"], `${path}.`);
  const name = text(raw["name"], `${path}.name`, 40);

  if (!NAME.test(name)) invalid(`${path}.name: use a-z, 0-9 and "-" (at most 40)`);
  const { min, max } = PROFILE_LIMITS.timeoutMinutes;
  const timeout = raw["timeout_minutes"] ?? PROFILE_LIMITS.timeoutMinutes.default;

  if (!Schema.is(Schema.Int)(timeout) || timeout < min || timeout > max)
    return invalid(`${path}.timeout_minutes: a whole number from ${min} to ${max}`);

  return {
    name,
    command: text(raw["command"], `${path}.command`, PROFILE_LIMITS.commandChars),
    timeoutMinutes: timeout,
  };
};

const parseScreen = (raw: Schema.Json, i: number): ProfileScreen => {
  const path = `screens[${i}]`;

  if (!isObj(raw)) return invalid(`${path}: must be a map`);
  onlyKeys(raw, ["route", "files"], `${path}.`);
  const route = text(raw["route"], `${path}.route`, PROFILE_LIMITS.routeChars);

  if (!route.startsWith("/")) invalid(`${path}.route: must start with /`);
  const files = textList(raw["files"], `${path}.files`, PROFILE_LIMITS.globs, 200);

  if (files.length === 0) invalid(`${path}.files: 1 to ${PROFILE_LIMITS.globs} patterns`);

  return { route, files };
};

/** Parses and validates a project profile. Returns null for an empty source (no profile). */
export const parseProfile = (source: string): ProfileSpec | null => {
  if (new TextEncoder().encode(source).byteLength > PROFILE_LIMITS.sourceBytes)
    invalid(`the profile is larger than ${PROFILE_LIMITS.sourceBytes / 1024} KiB`);

  if (source.trim() === "") return null;
  let raw: Schema.Json;

  try {
    raw = Schema.decodeUnknownSync(Schema.Json)(parseYaml(source, { maxAliasCount: 0, uniqueKeys: true }));
  } catch (e) {
    return invalid(`not valid YAML: ${e instanceof Error ? e.message.split("\n")[0] : "parse error"}`);
  }

  if (!isObj(raw)) return invalid("the profile must be a map");
  onlyKeys(raw, ["version", "stack", "services", "checks", "screens", "notes"], "");

  if (raw["version"] !== 1) invalid("version: must be 1");
  const services = list(raw["services"], "services", PROFILE_LIMITS.services).map(parseService);
  unique(
    services.map((s) => s.name),
    "services",
  );
  const checks = list(raw["checks"], "checks", PROFILE_LIMITS.checks).map(parseCheck);
  unique(
    checks.map((c) => c.name),
    "checks",
  );
  const screens = list(raw["screens"], "screens", PROFILE_LIMITS.screens).map(parseScreen);
  unique(
    screens.map((s) => s.route),
    "screens",
  );
  const notes = raw["notes"] === undefined ? "" : raw["notes"];

  if (
    !isText(notes) ||
    notes.split("\n").length > PROFILE_LIMITS.notesLines ||
    new TextEncoder().encode(notes).byteLength > PROFILE_LIMITS.notesBytes
  )
    invalid(`notes: at most ${PROFILE_LIMITS.notesLines} lines and 4 KiB`);

  return { stack: parseStack(raw["stack"]), services, checks, screens, notes: isText(notes) ? notes : "" };
};
