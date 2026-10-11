/** Redaction rule shared by every logger (05, Secrets). */
export const SECRET_FIELD = /token|key|secret|password|authorization|auth_json|cookie/i;

export const REDACTED = "[redacted]";

export const redact = (value: unknown, depth = 0): unknown => {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_FIELD.test(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
};
