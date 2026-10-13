import type { WorkspaceCore } from "../do/workspace/core.ts";

export const lifecycleRedactor = async (core: WorkspaceCore): Promise<(text: string) => string> => {
  const credentials = core.credentials();
  const status = await credentials.status();
  const values = new Set<string>();

  const collect = (value: unknown): void => {
    if (typeof value === "string" && value) values.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };

  for (const entry of status) {
    const secret = await credentials.getSecret(entry.key);

    if (!secret) continue;
    values.add(secret);

    if (entry.key === "codex.auth_json") {
      try {
        const auth = JSON.parse(secret);
        collect(auth.tokens);
        collect(auth.OPENAI_API_KEY);
      } catch {
        /* The whole value is still masked. */
      }
    }
  }

  const ordered = [...values].sort((a, b) => b.length - a.length);

  if (!ordered.length) return (text) => text;
  const pattern = new RegExp(ordered.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");

  return (text) => text.replace(pattern, () => "[redacted]");
};
