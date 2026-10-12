import type { AvailableCommand, ConfigOption, SessionMode } from "@tempo/protocol";

type Obj = Record<string, unknown>;
export const isObj = (u: unknown): u is Obj => typeof u === "object" && u !== null && !Array.isArray(u);
const str = (u: unknown): string | undefined => (typeof u === "string" ? u : undefined);

export const toModes = (u: unknown): SessionMode[] => {
  if (!Array.isArray(u)) return [];
  const out: SessionMode[] = [];
  for (const m of u) {
    if (!isObj(m) || typeof m["id"] !== "string") continue;
    const description = str(m["description"]);
    out.push({
      id: m["id"],
      name: str(m["name"]) ?? m["id"],
      ...(description !== undefined ? { description } : {}),
    });
  }
  return out;
};

const toSelectOptions = (u: unknown): NonNullable<ConfigOption["options"]> => {
  if (!Array.isArray(u)) return [];
  const out: Array<NonNullable<ConfigOption["options"]>[number]> = [];
  for (const o of u) {
    if (!isObj(o)) continue;
    if (Array.isArray(o["options"]) && typeof o["group"] === "string") {
      const options = toSelectOptions(o["options"]).filter((x) => !("group" in x)) as Array<{
        value: string;
        name: string;
        description?: string | null;
      }>;
      out.push({ group: o["group"], name: str(o["name"]) ?? o["group"], options });
    } else if (typeof o["value"] === "string") {
      const description = str(o["description"]);
      out.push({
        value: o["value"],
        name: str(o["name"]) ?? o["value"],
        ...(description !== undefined ? { description } : {}),
      });
    }
  }
  return out;
};

export const toConfigOptions = (u: unknown): ConfigOption[] => {
  if (!Array.isArray(u)) return [];
  const out: ConfigOption[] = [];
  for (const o of u) {
    if (!isObj(o) || typeof o["id"] !== "string") continue;
    const cv = o["currentValue"];
    if (typeof cv !== "string" && typeof cv !== "boolean") continue;
    const description = str(o["description"]);
    const category = str(o["category"]);
    out.push({
      id: o["id"],
      name: str(o["name"]) ?? o["id"],
      type: str(o["type"]) ?? (typeof cv === "boolean" ? "boolean" : "select"),
      ...(description !== undefined ? { description } : {}),
      ...(category !== undefined ? { category } : {}),
      currentValue: cv,
      ...(Array.isArray(o["options"]) ? { options: toSelectOptions(o["options"]) } : {}),
    });
  }
  return out;
};

export const toCommands = (u: unknown): AvailableCommand[] => {
  if (!Array.isArray(u)) return [];
  const out: AvailableCommand[] = [];
  for (const c of u) {
    if (!isObj(c) || typeof c["name"] !== "string") continue;
    const description = str(c["description"]);
    out.push({
      name: c["name"],
      ...(description !== undefined ? { description } : {}),
      ...(c["input"] !== undefined && c["input"] !== null ? { input: c["input"] } : {}),
    });
  }
  return out;
};

/** Drops ACP `_meta` and the `sessionUpdate` tag from an update object. */
export const stripMeta = (o: Obj, ...drop: string[]): Obj => {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) if (k !== "_meta" && !drop.includes(k)) out[k] = v;
  return out;
};

export const modeConfig = (options: readonly ConfigOption[]): ConfigOption | undefined =>
  options.find((o) => o.category === "mode" && o.type === "select" && typeof o.currentValue === "string");

export const configModes = (option: ConfigOption): SessionMode[] =>
  (option.options ?? [])
    .flatMap((entry) => ("group" in entry ? entry.options : [entry]))
    .map((entry) => ({
      id: entry.value,
      name: entry.name,
      ...(entry.description != null ? { description: entry.description } : {}),
    }));
