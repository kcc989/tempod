import { Schema, SchemaGetter } from "effect";
import { AcpFields, type Item, type ItemOf } from "@tempo/protocol";
import { diffLines } from "~/ui/lib/diff";
import { formatDuration } from "~/ui/lib/format";

/** Work rows, work types and tool call labels (04, Center). One model for every agent. */

export type TranscriptDetail = "default" | "detailed";

export type WorkType = "explore" | "edit" | "run" | "web" | "subagent" | "other";

type ToolItem = ItemOf<"tool_call">;

type Verb = "Read" | "Search" | "List";

const READ = new Set(["cat", "head", "tail", "less", "nl", "wc"]);

const SEARCH = new Set(["rg", "grep", "find", "fd", "ag"]);

const LIST = new Set(["ls", "tree"]);

const record = Schema.decodeUnknownSync(
  Schema.Unknown.pipe(
    Schema.decodeTo(Schema.NullOr(AcpFields), {
      decode: SchemaGetter.transform((value) => (Schema.is(AcpFields)(value) ? value : null)),
      encode: SchemaGetter.passthrough(),
    }),
  ),
);

const nonEmpty = Schema.decodeUnknownSync(
  Schema.Unknown.pipe(
    Schema.decodeTo(Schema.NullOr(Schema.String), {
      decode: SchemaGetter.transform((value) =>
        Schema.is(Schema.String)(value) && value.trim() !== "" ? value.trim() : null,
      ),
      encode: SchemaGetter.passthrough(),
    }),
  ),
);

/** The verb and label of a single read, search or list command; null for anything else. */
export const commandIntent = (command: string): { verb: Verb; label: string } | null => {
  const c = command.trim().replace(/^cd\s+\S+\s*(?:&&|;)\s*/, "");

  if (/[;\n]|&&|\|\|/.test(c)) return null;
  const [head = "", ...pipes] = c.split("|");

  if (!pipes.every((p) => /^\s*(?:head|tail)\b/.test(p))) return null;
  const [word = "", ...rest] = head.trim().split(/\s+/);
  let verb: Verb;
  let args = rest;

  if (word === "sed" && rest[0] === "-n") {
    verb = "Read";
    args = rest.slice(1);
  } else if (READ.has(word)) verb = "Read";
  else if (SEARCH.has(word)) verb = "Search";
  else if (LIST.has(word)) verb = "List";
  else return null;

  return { verb, label: [verb, ...args].join(" ") };
};

const command = (item: ToolItem): string => {
  const input = record(item.content.rawInput);

  return nonEmpty(input?.["command"]) ?? item.content.title;
};

export const workType = (item: ToolItem): WorkType => {
  switch (item.content.toolKind) {
    case "read":
    case "search":
      return "explore";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "execute":
      return commandIntent(command(item)) ? "explore" : "run";
    case "fetch":
      return "web";
    case "think": {
      const input = record(item.content.rawInput);

      const subagent =
        Schema.is(Schema.String)(input?.["subagent_type"]) ||
        (Schema.is(Schema.String)(input?.["prompt"]) && Schema.is(Schema.String)(input?.["description"]));

      return subagent ? "subagent" : "other";
    }

    default:
      return "other";
  }
};

/** The row label: intent, not the raw command. `mono` when it falls back to an execute title. */
export const toolLabel = (item: ToolItem) => {
  const { toolKind, title } = item.content;

  if (toolKind === "execute") {
    const description = nonEmpty(record(item.content.rawInput)?.["description"]);

    if (description) return { text: description, mono: false } satisfies { text: string; mono: boolean };
    const intent = commandIntent(command(item));

    if (intent) return { text: intent.label, mono: false } satisfies { text: string; mono: boolean };

    return { text: title || "Command", mono: true } satisfies { text: string; mono: boolean };
  }

  return { text: title || "Tool call", mono: false } satisfies { text: string; mono: boolean };
};

/** Explore calls that search, by ACP kind or by command verb. */
const isSearch = (item: ToolItem): boolean =>
  item.content.toolKind === "search" ||
  (item.content.toolKind === "execute" && commandIntent(command(item))?.verb === "Search");

export interface EditCounts {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
}

/** File name and line counts of an edit call, from its diff content. */
export const editCounts = (item: ToolItem): EditCounts | null => {
  let path = "";
  let added = 0;
  let removed = 0;
  let any = false;

  for (const c of item.content.content) {
    if (c["type"] !== "diff") continue;
    any = true;

    if (!path && Schema.is(Schema.String)(c["path"])) path = c["path"];
    const oldText = Schema.is(Schema.String)(c["oldText"]) ? c["oldText"] : "";
    const newText = Schema.is(Schema.String)(c["newText"]) ? c["newText"] : "";

    for (const line of diffLines(oldText, newText)) {
      if (line.kind === "add") added++;
      else if (line.kind === "del") removed++;
    }
  }

  if (!path) path = item.content.locations[0]?.path ?? "";

  return any || path ? { path, added, removed } : null;
};

const count = (n: number, one: string, many: string): string =>
  (n === 1 ? one : many).replace("<n>", String(n));

/** `Explored 14 files · ran 2 commands · 48s` (04, Work row). */
export const workSummary = (folded: ReadonlyArray<Item>, durationMs: number | null): string => {
  const files = new Set<string>();
  let fileCalls = 0;
  let searches = 0;
  let commands = 0;
  let pages = 0;
  let agents = 0;
  let tools = 0;
  let thoughts = 0;

  for (const item of folded) {
    if (item.kind === "agent_thought") thoughts++;

    if (item.kind !== "tool_call") continue;

    switch (workType(item)) {
      case "explore":
        if (isSearch(item)) searches++;
        else if (item.content.locations.length === 0) fileCalls++;
        else for (const l of item.content.locations) files.add(l.path);
        break;
      case "run":
        commands++;
        break;
      case "web":
        pages++;
        break;
      case "subagent":
        agents++;
        break;
      default:
        tools++;
    }
  }

  const explored = files.size + fileCalls;

  const parts = [
    explored > 0 ? count(explored, "explored 1 file", "explored <n> files") : null,
    searches > 0 ? count(searches, "1 search", "<n> searches") : null,
    commands > 0 ? count(commands, "ran 1 command", "ran <n> commands") : null,
    pages > 0 ? count(pages, "fetched 1 page", "fetched <n> pages") : null,
    agents > 0 ? count(agents, "ran 1 agent", "ran <n> agents") : null,
    tools > 0 ? count(tools, "used 1 tool", "used <n> tools") : null,
  ].filter((p): p is string => p !== null);

  if (parts.length === 0 && thoughts > 0) parts.push(count(thoughts, "thought 1 time", "thought <n> times"));

  if (durationMs !== null) parts.push(formatDuration(durationMs));
  const text = parts.join(" · ");

  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** 04 Plan proposals: a tool call whose `rawInput.plan` is a non-empty string (Claude's ExitPlanMode). */
export const planProposalText = (item: Item): string | null => {
  if (item.kind !== "tool_call") return null;
  const raw = item.content.rawInput;
  const plan = record(raw)?.["plan"];

  return Schema.is(Schema.String)(plan) && plan.trim() !== "" ? plan : null;
};

/** True when Default detail folds the item into its turn's work row. */
export const foldsIntoWork = (item: Item, lastMessageId: string | undefined): boolean => {
  switch (item.kind) {
    case "agent_thought":
      return true;
    case "agent_message":
      return item.id !== lastMessageId;
    case "tool_call":
      return (
        item.status !== "failed" &&
        item.status !== "cancelled" &&
        workType(item) !== "edit" &&
        planProposalText(item) === null
      );
    default:
      return false;
  }
};

/** The label of the newest call in a running work row. */
export const currentStep = (folded: ReadonlyArray<Item>): string | null => {
  for (let i = folded.length - 1; i >= 0; i--) {
    const item = folded[i]!;

    if (item.kind === "tool_call") return toolLabel(item).text;

    if (item.kind === "agent_thought") return "Thinking";
  }

  return null;
};
