import { redactFields, type RedactableFields } from "@tempo/protocol";

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const MIN: Level = "info";

export interface LogFields extends RedactableFields {
  readonly workspaceId?: string;
  readonly opId?: string;
  readonly step?: string;
}

/** Structured JSON log line (05, Observability). Every field passes through the redact rule. */
export const log = (level: Level, msg: string, fields: LogFields = {}): void => {
  if (ORDER[level] < ORDER[MIN]) return;
  const line = JSON.stringify({ ts: Date.now(), level, msg, ...redactFields(fields) });

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export const errorText = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause)).slice(0, 2000);
