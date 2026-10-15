import {
  DEPLOY_PERMISSIONS,
  DEPLOY_ROLLOUTS,
  DEPLOY_TOOL_KINDS,
  TempoError,
  isHostPattern,
  type DeployPermission,
  type DeployTarget,
  type DeployTool,
} from "@tempo/protocol";
import { Schema } from "effect";
import { parse as parseYaml } from "yaml";

/** 12, Deploy configuration. */
export const DEPLOY_LIMITS = {
  sourceBytes: 16 * 1024,
  targets: 10,
  commandChars: 4096,
  rootChars: 200,
  timeoutMinutes: { min: 1, max: 60, default: 20 },
  egressHosts: 50,
  workers: 10,
  smokeUrls: 5,
  smokeUrlChars: 2048,
} as const;

export interface DeploySpec {
  readonly tool: DeployTool;
  readonly root: string;
  readonly install: string | null;
  readonly build: string | null;
  readonly permissions: ReadonlyArray<DeployPermission>;
  readonly timeoutMinutes: number;
  readonly egressAllowlist: ReadonlyArray<string>;
  readonly targets: ReadonlyArray<DeployTarget>;
  readonly autoFix: boolean;
}

const KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const SEGMENT = /^[A-Za-z0-9._-]+$/;

const WORKER = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const invalid = (detail: string): never => {
  throw new TempoError("DEPLOY_CONFIG_INVALID", undefined, detail);
};

const isText = Schema.is(Schema.String);

const isWhole = Schema.is(Schema.Int);

const isObj = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Schema.is(Schema.JsonObject)(value);

const onlyKeys = (value: Schema.JsonObject, allowed: ReadonlyArray<string>, path: string): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(`${path}${key}: unknown key`);
  }
};

const stringList = (value: Schema.Json | undefined, path: string): string[] => {
  if (value === undefined) return [];

  if (!Array.isArray(value)) return invalid(`${path}: must be a list of strings`);
  const list = value.filter(isText);

  if (list.length !== value.length) invalid(`${path}: must be a list of strings`);

  if (new Set(list).size !== list.length) invalid(`${path}: duplicate entries`);

  return list;
};

const command = (value: Schema.Json | undefined, path: string): string | null => {
  if (value === undefined) return null;

  if (!isText(value) || value.trim() === "") return invalid(`${path}: must be a nonempty string`);

  if (value.length > DEPLOY_LIMITS.commandChars)
    invalid(`${path}: at most ${DEPLOY_LIMITS.commandChars} characters`);

  return value;
};

const flag = (value: Schema.Json | undefined, path: string): boolean => {
  if (value === undefined) return false;

  if (!Schema.is(Schema.Boolean)(value)) return invalid(`${path}: must be true or false`);

  return value;
};

const parseRoot = (value: Schema.Json | undefined): string => {
  if (value === undefined) return "";

  if (!isText(value)) return invalid("root: must be a string");
  const segments = value.split("/");

  if (
    value.length > DEPLOY_LIMITS.rootChars ||
    segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..")
  )
    invalid(`root: a relative directory such as apps/web (at most ${DEPLOY_LIMITS.rootChars} characters)`);

  return value;
};

const parseTarget = (key: string, raw: Schema.Json, isBranch: (branch: string) => boolean): DeployTarget => {
  const path = `targets.${key}`;

  if (!KEY.test(key)) invalid(`${path}: target keys use a-z, 0-9, "-" and "_" (at most 40)`);

  if (!isObj(raw)) return invalid(`${path}: must be a map`);
  onlyKeys(raw, ["stage", "branch", "auto", "agent", "rollout", "workers", "smoke"], `${path}.`);
  let stage = key;

  if (raw["stage"] !== undefined) {
    if (!isText(raw["stage"]) || !KEY.test(raw["stage"]))
      return invalid(`${path}.stage: use a-z, 0-9, "-" and "_" (at most 40)`);
    stage = raw["stage"];
  }

  let branch: string | null = null;

  if (raw["branch"] !== undefined) {
    if (!isText(raw["branch"]) || !isBranch(raw["branch"]))
      return invalid(`${path}.branch: not a valid branch name`);
    branch = raw["branch"];
  }

  const auto = flag(raw["auto"], `${path}.auto`);

  if (auto && branch === null) invalid(`${path}.auto: needs branch`);

  const rollout = raw["rollout"] ?? "full";

  if (!DEPLOY_ROLLOUTS.some((r) => r === rollout)) return invalid(`${path}.rollout: full or gradual`);
  const workers = stringList(raw["workers"], `${path}.workers`);

  if (workers.length > DEPLOY_LIMITS.workers) invalid(`${path}.workers: at most ${DEPLOY_LIMITS.workers}`);
  const badWorker = workers.find((w) => !WORKER.test(w));

  if (badWorker !== undefined) invalid(`${path}.workers: "${badWorker}" is not a Worker name`);

  if (rollout === "gradual" && workers.length === 0) invalid(`${path}.rollout: gradual needs workers`);
  const smoke = stringList(raw["smoke"], `${path}.smoke`);

  if (smoke.length > 0 && rollout !== "gradual") invalid(`${path}.smoke: needs rollout: gradual`);

  if (smoke.length > DEPLOY_LIMITS.smokeUrls) invalid(`${path}.smoke: at most ${DEPLOY_LIMITS.smokeUrls}`);

  const badUrl = smoke.find(
    (u) => u.length > DEPLOY_LIMITS.smokeUrlChars || !URL.canParse(u) || !u.startsWith("https://"),
  );

  if (badUrl !== undefined) invalid(`${path}.smoke: "${badUrl}" is not an https URL`);

  return {
    key,
    stage,
    branch,
    auto,
    agent: flag(raw["agent"], `${path}.agent`),
    rollout: rollout === "gradual" ? "gradual" : "full",
    workers,
    smoke,
  };
};

/**
 * Parses and validates an owner deploy configuration (12, Deploy configuration). Returns null for
 * an empty source, which disables deploys. Throws `DEPLOY_CONFIG_INVALID` with the first problem.
 */
export const parseDeployConfig = (
  source: string,
  isBranch: (branch: string) => boolean,
): DeploySpec | null => {
  if (new TextEncoder().encode(source).byteLength > DEPLOY_LIMITS.sourceBytes)
    invalid(`the configuration is larger than ${DEPLOY_LIMITS.sourceBytes / 1024} KiB`);

  if (source.trim() === "") return null;
  let raw: Schema.Json;

  try {
    raw = Schema.decodeUnknownSync(Schema.Json)(parseYaml(source, { maxAliasCount: 0, uniqueKeys: true }));
  } catch (e) {
    return invalid(`not valid YAML: ${e instanceof Error ? e.message.split("\n")[0] : "parse error"}`);
  }

  if (!isObj(raw)) return invalid("the configuration must be a map");
  onlyKeys(
    raw,
    [
      "version",
      "tool",
      "root",
      "install",
      "build",
      "permissions",
      "timeout_minutes",
      "egress_allowlist",
      "targets",
      "auto_fix",
    ],
    "",
  );

  if (raw["version"] !== 1) invalid("version: must be 1");
  const tool = raw["tool"];

  if (!DEPLOY_TOOL_KINDS.some((t) => t === tool)) return invalid(`tool: ${DEPLOY_TOOL_KINDS.join(" or ")}`);
  const listed = stringList(raw["permissions"], "permissions");
  const unknown = listed.find((p) => !DEPLOY_PERMISSIONS.some((known) => known === p));

  if (unknown !== undefined) invalid(`permissions: unknown permission "${unknown}"`);
  const permissions = DEPLOY_PERMISSIONS.filter((p) => p === "workers" || listed.includes(p));
  const { min, max } = DEPLOY_LIMITS.timeoutMinutes;
  const timeoutMinutes = raw["timeout_minutes"] ?? DEPLOY_LIMITS.timeoutMinutes.default;

  if (!isWhole(timeoutMinutes) || timeoutMinutes < min || timeoutMinutes > max)
    return invalid(`timeout_minutes: a whole number from ${min} to ${max}`);

  const egressAllowlist = stringList(raw["egress_allowlist"], "egress_allowlist");

  if (egressAllowlist.length > DEPLOY_LIMITS.egressHosts)
    invalid(`egress_allowlist: at most ${DEPLOY_LIMITS.egressHosts} hosts`);
  const badHost = egressAllowlist.find((host) => !isHostPattern(host));

  if (badHost !== undefined) invalid(`egress_allowlist: "${badHost}" is not a host or *.host`);
  const rawTargets = raw["targets"];

  if (!isObj(rawTargets)) return invalid("targets: required map");
  const entries = Object.entries(rawTargets);

  if (entries.length < 1 || entries.length > DEPLOY_LIMITS.targets)
    invalid(`targets: 1 to ${DEPLOY_LIMITS.targets} targets`);

  return {
    tool: tool === "alchemy" ? "alchemy" : "cloudflare-config",
    root: parseRoot(raw["root"]),
    install: command(raw["install"], "install"),
    build: command(raw["build"], "build"),
    permissions,
    timeoutMinutes,
    egressAllowlist,
    targets: entries.map(([key, target]) => parseTarget(key, target, isBranch)),
    autoFix: flag(raw["auto_fix"], "auto_fix"),
  };
};
