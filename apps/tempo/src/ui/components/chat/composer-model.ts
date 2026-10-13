import { Schema } from "effect";
import type { AcpFields } from "@tempo/protocol";
import {
  flattenConfigOptions,
  type AvailableCommand,
  type ConfigOption,
  type Mention,
  type ProfileIssue,
  type Session,
} from "@tempo/protocol";
import { agentLabel } from "~/ui/lib/agents";
import { fuzzyFilter } from "~/ui/lib/fuzzy";
import type { PendingInsertion } from "~/ui/state/workspace-ui";

/** Pure helpers for the composer (04, Composer). */
/** localStorage key (under the `tempo:` prefix) of one session's draft text. */
export const draftKey = (workspaceId: string, sessionId: string): string =>
  `composer:draft:${workspaceId}:${sessionId}`;

export const isDraft = (u: unknown): u is string => Schema.is(Schema.String)(u);

/** 02: one file per upload, at most 10 MiB. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const splitBySize = <F extends { readonly size: number }>(files: ReadonlyArray<F>) =>
  ({
    ok: files.filter((f) => f.size <= MAX_ATTACHMENT_BYTES),
    tooLarge: files.filter((f) => f.size > MAX_ATTACHMENT_BYTES),
  }) satisfies { readonly ok: F[]; readonly tooLarge: F[] };

export interface Trigger {
  /** Index of the `@` or `/`. */
  readonly start: number;
  readonly query: string;
}

/** `@query` right before the caret, at the start or after whitespace. */
export const mentionTrigger = (text: string, caret: number): Trigger | null => {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);

  if (!m) return null;

  return { start: before.length - m[2]!.length - 1, query: m[2]! };
};

/** `/query` as the whole text before the caret (a command goes first in the message). */
export const slashTrigger = (text: string, caret: number): Trigger | null => {
  const before = text.slice(0, caret);
  const m = /^\/([^\s/]*)$/.exec(before);

  return m ? { start: 0, query: m[1]! } : null;
};

/** Replaces the trigger text (`@query` or `/query`) with `insert`; returns the new text and caret. */
export const replaceTrigger = (text: string, caret: number, trigger: Trigger, insert: string) => {
  const after = text.slice(caret);
  const head = text.slice(0, trigger.start) + insert;

  return { text: head + after, caret: head.length } satisfies {
    readonly text: string;
    readonly caret: number;
  };
};

export interface SlashEntry {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly kind: "agent" | "plan";
}

/** The `/` menu: the agent's own commands plus Tempo's `/plan` when the agent has plan mode. */
export const slashEntries = (
  commands: ReadonlyArray<AvailableCommand>,
  planAvailable: boolean,
  query: string,
): SlashEntry[] => {
  const all: SlashEntry[] = [
    ...(planAvailable
      ? [{ key: "tempo:plan", name: "plan", description: "Toggle plan mode", kind: "plan" as const }]
      : []),
    ...commands.map((c) => ({
      key: `agent:${c.name}`,
      name: c.name,
      description: c.description ?? "",
      kind: "agent" as const,
    })),
  ];

  return fuzzyFilter(query, all, (e) => e.name, 50);
};

export interface ComposerChips {
  readonly text: string;
  readonly mentions: ReadonlyArray<Mention>;
  readonly reviewCommentIds: ReadonlyArray<string>;
}

/** Applies insertions from the shared store: mention chips, the review-comment chip, text. */
export const applyInsertions = (
  state: ComposerChips,
  insertions: ReadonlyArray<PendingInsertion>,
): ComposerChips => {
  let { text } = state;
  const mentions = [...state.mentions];
  const reviewCommentIds = [...state.reviewCommentIds];

  for (const { insertion } of insertions) {
    if (insertion.kind === "mention") {
      if (!mentions.some((m) => m.path === insertion.path)) mentions.push({ path: insertion.path });
    } else if (insertion.kind === "reviewComments") {
      for (const id of insertion.commentIds) if (!reviewCommentIds.includes(id)) reviewCommentIds.push(id);
    } else if (insertion.text) {
      text =
        text === "" ? insertion.text : /\s$/.test(text) ? text + insertion.text : `${text} ${insertion.text}`;
    }
  }

  return { text, mentions, reviewCommentIds };
};

export const reviewChipLabel = (n: number): string => (n === 1 ? "1 review comment" : `${n} review comments`);

export const canSend = (input: {
  readonly text: string;
  readonly attachmentCount: number;
  readonly reviewCommentCount: number;
  readonly uploading: boolean;
}): boolean =>
  !input.uploading && (input.text.trim() !== "" || input.attachmentCount > 0 || input.reviewCommentCount > 0);

/** The first line of a queued prompt, cut for a chip. */
export const chipLabel = (text: string, max = 48): string => {
  const line =
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? "";

  return line.length > max ? `${line.slice(0, max - 1)}…` : line || "Empty message";
};

export interface ContextUsage {
  readonly used: number;
  readonly size: number;
  readonly ratio: number;
}

/** ACP usage_update: `used` tokens in context of `size`. */
export const contextUsage = (usage: AcpFields): ContextUsage | null => {
  const used = usage["used"];
  const size = usage["size"];

  if (!Schema.is(Schema.Number)(used) || !Schema.is(Schema.Number)(size) || !(size > 0) || used < 0)
    return null;

  return { used, size, ratio: Math.min(1, used / size) };
};

export interface ConfigPickers {
  /** The option whose category is `model` (01: there is no session/set_model). */
  readonly model: ConfigOption | undefined;
  /** A `mode` config option, used only when the agent reports no modes. */
  readonly modeOption: ConfigOption | undefined;
  /** The reasoning level: the option whose category is `thought_level` (04, Composer). */
  readonly thoughtLevel: ConfigOption | undefined;
  readonly others: ReadonlyArray<ConfigOption>;
}

export const configPickers = (session: Pick<Session, "configOptions" | "modes">): ConfigPickers => {
  const model = session.configOptions.find((o) => o.category === "model");
  const mode = session.configOptions.find((o) => o.category === "mode");
  const modeOption = session.modes.length === 0 ? mode : undefined;
  const level = session.configOptions.find((o) => o.category === "thought_level" && o.type === "select");

  const others = session.configOptions.filter(
    (o) => o !== model && o !== mode && o !== level && (o.type === "select" || o.type === "boolean"),
  );

  return { model, modeOption, thoughtLevel: level, others };
};

/** The display name of an option's current value. */
export const currentValueLabel = (option: ConfigOption): string => {
  if (Schema.is(Schema.Boolean)(option.currentValue)) return option.currentValue ? "On" : "Off";

  return (
    flattenConfigOptions(option).find((o) => o.value === option.currentValue)?.name ?? option.currentValue
  );
};

/** Grouped select values for a picker, keeping the agent's groups. */
export const optionGroups = (
  option: ConfigOption,
): ReadonlyArray<{
  readonly name: string | null;
  readonly values: ReadonlyArray<{ value: string; name: string }>;
}> => {
  const out: Array<{ name: string | null; values: Array<{ value: string; name: string }> }> = [];

  for (const o of option.options ?? []) {
    if ("group" in o)
      out.push({ name: o.name, values: o.options.map((v) => ({ value: v.value, name: v.name })) });
    else {
      const last = out[out.length - 1];

      if (last && last.name === null) last.values.push({ value: o.value, name: o.name });
      else out.push({ name: null, values: [{ value: o.value, name: o.name }] });
    }
  }

  return out;
};

/** Moves an item within a list (for keyboard reordering of queued chips). */
export const moveIndex = (length: number, from: number, delta: number): number =>
  Math.max(0, Math.min(length - 1, from + delta));

const ISSUE_LABELS: Record<ProfileIssue, string> = {
  systemPrompt: "system prompt",
  tools: "tool limits",
  mcpServers: "MCP servers",
  model: "model",
  thoughtLevel: "reasoning level",
  access: "read-only controls",
};

/** The profile-issues notice (04, Composer): null when there is nothing to show. */
export const profileIssuesText = (
  session: Pick<Session, "agent" | "customAgent" | "profileIssues">,
): string | null => {
  const issues = session.profileIssues ?? [];

  if (!session.customAgent || issues.length === 0) return null;

  return `${agentLabel(session.agent)} ignored some settings of ${session.customAgent.name}: ${issues
    .map((i) => ISSUE_LABELS[i])
    .join(", ")}`;
};
