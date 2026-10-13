import { Schema } from "effect";
import { AgentDefinition, TempoError } from "@tempo/protocol";
import { parseRoleFile } from "@tempo/settings";
import type { WorkspaceCore } from "../do/workspace/core.ts";
import type { RunRow } from "../db/workspace-do.ts";

export const migrateRunDefinition = (core: WorkspaceCore, run: RunRow): AgentDefinition => {
  const text = core.kv<string>(`runFile:${run.id}`);

  if (!text) throw new TempoError("AGENT_INVALID");
  const { file, body } = parseRoleFile(run.handle, text);

  const definition = Schema.decodeUnknownSync(AgentDefinition)({
    handle: run.handle,
    name: run.handle,
    description: file.description,
    baseAgent: file.agent === "other" ? "auto" : file.agent,
    model: file.model === "default" ? "" : file.model,
    access: file.access,
    prompt: body.slice(0, 32000),
    outputKind: run.outputKind,
  });

  core.setKv(`runDefinition:${run.id}`, JSON.stringify(definition));
  core.setKv(`runOptions:${run.id}`, { timeout: file.limits.timeout });

  return definition;
};
