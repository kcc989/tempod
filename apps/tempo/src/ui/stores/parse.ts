import { HubServerMessage, WorkspaceServerMessage } from "@tempo/protocol";
import { Result, Schema } from "effect";

const decodeHub = Schema.decodeUnknownResult(HubServerMessage);
const decodeWorkspace = Schema.decodeUnknownResult(WorkspaceServerMessage);

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/** Decodes one hub channel frame; null (and a console warning) when it does not match the schema. */
export const parseHubMessage = (raw: string): HubServerMessage | null => {
  const r = decodeHub(parseJson(raw));
  if (Result.isSuccess(r)) return r.success;
  console.warn("tempo: dropped hub message", String(r.failure));
  return null;
};

export const parseWorkspaceMessage = (raw: string): WorkspaceServerMessage | null => {
  const r = decodeWorkspace(parseJson(raw));
  if (Result.isSuccess(r)) return r.success;
  console.warn("tempo: dropped workspace message", String(r.failure));
  return null;
};

/** A `hello` whose `v` is not 1 (02 Conventions: close with 4400). */
export const isUnknownVersionHello = (raw: string): boolean => {
  const m = parseJson(raw) as { type?: unknown; v?: unknown } | undefined;
  return typeof m === "object" && m !== null && m.type === "hello" && m.v !== 1;
};
