import { TempoError, isHostPattern, type CiJobSpec } from "@tempo/protocol";
import { Schema } from "effect";
import { parse as parseYaml } from "yaml";

/** 10, Pipeline file. */
export const CI_LIMITS = {
  sourceBytes: 64 * 1024,
  jobs: 10,
  runChars: 16_384,
  nameChars: 64,
  timeoutMinutes: { min: 1, max: 60, default: 20 },
  egressHosts: 50,
} as const;

export interface CiJobDefinition extends CiJobSpec {
  readonly run: string;
}

export interface CiPipelineSpec {
  readonly jobs: ReadonlyArray<CiJobDefinition>;
  readonly required: ReadonlyArray<string>;
  readonly egressAllowlist: ReadonlyArray<string>;
}

const JOB_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const invalid = (detail: string): never => {
  throw new TempoError("CI_PIPELINE_INVALID", undefined, detail);
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

const parseJob = (key: string, raw: Schema.Json): CiJobDefinition => {
  const path = `jobs.${key}`;

  if (!JOB_KEY.test(key)) invalid(`${path}: job keys use a-z, 0-9, "-" and "_" (at most 40)`);

  if (!isObj(raw)) return invalid(`${path}: must be a map`);
  onlyKeys(raw, ["run", "name", "needs", "timeout_minutes"], `${path}.`);
  const { run, name, timeout_minutes: timeout } = raw;

  if (!isText(run) || run.trim() === "") return invalid(`${path}.run: required`);

  if (run.length > CI_LIMITS.runChars) invalid(`${path}.run: at most ${CI_LIMITS.runChars} characters`);
  let title = key;

  if (name !== undefined) {
    if (!isText(name)) return invalid(`${path}.name: must be a string`);
    title = name.trim();

    if (title.length < 1 || title.length > CI_LIMITS.nameChars)
      invalid(`${path}.name: 1 to ${CI_LIMITS.nameChars} characters`);
  }

  const { min, max } = CI_LIMITS.timeoutMinutes;
  const timeoutMinutes = timeout ?? CI_LIMITS.timeoutMinutes.default;

  if (!isWhole(timeoutMinutes) || timeoutMinutes < min || timeoutMinutes > max)
    return invalid(`${path}.timeout_minutes: a whole number from ${min} to ${max}`);

  const needs = stringList(raw["needs"], `${path}.needs`);

  if (needs.includes(key)) invalid(`${path}.needs: a job cannot need itself`);

  return { key, name: title, needs, timeoutMinutes, run };
};

const checkCycles = (jobs: ReadonlyArray<CiJobDefinition>): void => {
  const byKey = new Map(jobs.map((job) => [job.key, job]));
  const done = new Set<string>();
  const visiting = new Set<string>();

  const visit = (key: string): void => {
    if (done.has(key)) return;

    if (visiting.has(key)) invalid(`jobs.${key}.needs: jobs need each other in a cycle`);
    visiting.add(key);

    for (const need of byKey.get(key)?.needs ?? []) visit(need);
    visiting.delete(key);
    done.add(key);
  };

  for (const job of jobs) visit(job.key);
};

/**
 * Parses and validates an owner pipeline (10, Pipeline file). Returns null for an empty source,
 * which disables CI. Throws `CI_PIPELINE_INVALID` with the first problem as its detail.
 */
export const parseCiPipeline = (source: string): CiPipelineSpec | null => {
  if (new TextEncoder().encode(source).byteLength > CI_LIMITS.sourceBytes)
    invalid(`the pipeline is larger than ${CI_LIMITS.sourceBytes / 1024} KiB`);

  if (source.trim() === "") return null;
  let raw: Schema.Json;

  try {
    raw = Schema.decodeUnknownSync(Schema.Json)(parseYaml(source, { maxAliasCount: 0, uniqueKeys: true }));
  } catch (e) {
    return invalid(`not valid YAML: ${e instanceof Error ? e.message.split("\n")[0] : "parse error"}`);
  }

  if (!isObj(raw)) return invalid("the pipeline must be a map");
  onlyKeys(raw, ["version", "jobs", "required", "egress_allowlist"], "");

  if (raw["version"] !== 1) invalid("version: must be 1");
  const rawJobs = raw["jobs"];

  if (!isObj(rawJobs)) return invalid("jobs: required map");
  const entries = Object.entries(rawJobs);

  if (entries.length < 1 || entries.length > CI_LIMITS.jobs) invalid(`jobs: 1 to ${CI_LIMITS.jobs} jobs`);
  const jobs = entries.map(([key, job]) => parseJob(key, job));
  const keys = new Set(jobs.map((job) => job.key));

  for (const job of jobs) {
    const unknown = job.needs.find((need) => !keys.has(need));

    if (unknown !== undefined) invalid(`jobs.${job.key}.needs: unknown job "${unknown}"`);
  }

  checkCycles(jobs);
  const required = raw["required"] === undefined ? [...keys] : stringList(raw["required"], "required");
  const unknownRequired = required.find((key) => !keys.has(key));

  if (unknownRequired !== undefined) invalid(`required: unknown job "${unknownRequired}"`);
  const egressAllowlist = stringList(raw["egress_allowlist"], "egress_allowlist");

  if (egressAllowlist.length > CI_LIMITS.egressHosts)
    invalid(`egress_allowlist: at most ${CI_LIMITS.egressHosts} hosts`);
  const badHost = egressAllowlist.find((host) => !isHostPattern(host));

  if (badHost !== undefined) invalid(`egress_allowlist: "${badHost}" is not a host or *.host`);

  return { jobs, required, egressAllowlist };
};
