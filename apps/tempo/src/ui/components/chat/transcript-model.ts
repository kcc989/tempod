import { Schema, SchemaGetter } from "effect";
import {
  AcpFields,
  ERROR_CODES,
  errorMessage,
  type AgentId,
  type ErrorCode,
  type Item,
  type ItemOf,
  type PermissionOption,
  type Turn,
} from "@tempo/protocol";
import type { DiffLine } from "~/ui/lib/diff";
import { formatTokens } from "~/ui/lib/format";
import { foldsIntoWork, planProposalText, type TranscriptDetail } from "./work-model";

/** Pure helpers for the transcript (04, Transcript; 02, Item model). */
export type TranscriptRow =
  | {
      readonly kind: "item";
      readonly key: string;
      readonly itemId: string;
      readonly turnId: string | null;
      /** The item's turn was reverted: 50% opacity. */
      readonly dim: boolean;
      /** A plan proposal's permission item, shown under its card (04, Plan proposals). */
      readonly permissionId?: string;
    }
  | {
      readonly kind: "work";
      readonly key: string;
      readonly turnId: string;
      /** Folded items, in order (04, Work row). */
      readonly itemIds: ReadonlyArray<string>;
      readonly dim: boolean;
    }
  | {
      readonly kind: "footer";
      readonly key: string;
      readonly turnId: string;
      readonly dim: boolean;
      /** The turn has a work row, which shows the duration. */
      readonly worked: boolean;
    }
  | { readonly kind: "working"; readonly key: string; readonly turnId: string };

const ENDED = new Set<Turn["status"]>(["completed", "cancelled", "failed", "interrupted"]);

export const isEnded = (t: Pick<Turn, "status">): boolean => ENDED.has(t.status);

/**
 * The rows of one session's transcript. A user message of a queued turn shows as a chip above the
 * composer, so it is left out; one whose turn was deleted is gone. A started turn's user message
 * sits at the turn's start, so prompts that waited in the queue come after the turn before them.
 * Each ended turn gets a footer; a running turn gets a working row at the end. In Default detail a
 * turn's work items fold into one work row, placed before the turn's first other item.
 */
export const buildTranscriptRows = (
  order: ReadonlyArray<string>,
  items: Readonly<Record<string, Item>>,
  turns: Readonly<Record<string, Turn>>,
  detail: TranscriptDetail = "default",
): TranscriptRow[] => {
  const placed: Array<{ item: Item; at: number; rank: number; index: number }> = [];
  order.forEach((id, index) => {
    const item = items[id];

    if (!item) return;
    const turn = item.turnId ? turns[item.turnId] : undefined;

    if (item.kind === "user_message") {
      if (item.turnId && !turn) return;

      if (turn?.status === "queued") return;
      placed.push({ item, at: turn?.startedAt ?? item.createdAt, rank: 0, index });

      return;
    }

    placed.push({ item, at: item.createdAt, rank: 1, index });
  });
  placed.sort((a, b) => a.at - b.at || a.rank - b.rank || a.index - b.index);
  const planByToolCall = new Map<string, string>();

  for (const { item } of placed)
    if (item.kind === "tool_call" && planProposalText(item) !== null)
      planByToolCall.set(item.content.toolCallId, item.id);
  const permissionOfPlan = new Map<string, string>();

  for (let i = placed.length - 1; i >= 0; i--) {
    const item = placed[i]!.item;
    const plan = item.kind === "permission" ? planByToolCall.get(item.content.toolCallId ?? "") : undefined;

    if (plan === undefined) continue;
    permissionOfPlan.set(plan, item.id);
    placed.splice(i, 1);
  }

  const last = new Map<string, number>();
  placed.forEach((p, i) => {
    if (p.item.turnId) last.set(p.item.turnId, i);
  });
  const folded = new Map<string, string[]>();

  if (detail === "default") {
    const lastMessage = new Map<string, string>();

    for (const p of placed)
      if (p.item.kind === "agent_message" && p.item.turnId) lastMessage.set(p.item.turnId, p.item.id);

    for (const p of placed) {
      const turnId = p.item.turnId;

      if (!turnId || !turns[turnId] || !foldsIntoWork(p.item, lastMessage.get(turnId))) continue;
      const ids = folded.get(turnId) ?? [];
      ids.push(p.item.id);
      folded.set(turnId, ids);
    }
  }

  const rows: TranscriptRow[] = [];
  const placedWork = new Set<string>();
  let running: Turn | undefined;
  placed.forEach((p, i) => {
    const turn = p.item.turnId ? turns[p.item.turnId] : undefined;
    const dim = turn?.reverted === true;
    const work = turn ? folded.get(turn.id) : undefined;

    if (turn && work && p.item.kind !== "user_message" && !placedWork.has(turn.id)) {
      placedWork.add(turn.id);
      rows.push({ kind: "work", key: `work:${turn.id}`, turnId: turn.id, itemIds: work, dim });
    }

    if (!work?.includes(p.item.id)) {
      const permissionId = permissionOfPlan.get(p.item.id);

      let row: Extract<TranscriptRow, { kind: "item" }> = {
        kind: "item",
        key: p.item.id,
        itemId: p.item.id,
        turnId: p.item.turnId,
        dim,
      };

      if (permissionId) row = { ...row, permissionId };
      rows.push(row);
    }

    if (!turn || last.get(turn.id) !== i) return;

    if (isEnded(turn))
      rows.push({
        kind: "footer",
        key: `footer:${turn.id}`,
        turnId: turn.id,
        dim,
        worked: work !== undefined,
      });
    else if (turn.status === "running" && !work) running = turn;
  });

  if (running) rows.push({ kind: "working", key: `working:${running.id}`, turnId: running.id });

  return rows;
};

/** Virtualize the transcript past this many rows (04, Long lists). */
export const VIRTUALIZE_AFTER = 200;

/** Agent messages that finished and were not announced yet, in order. Marks them as seen. */
export const messagesToAnnounce = (
  seen: Set<string>,
  order: ReadonlyArray<string>,
  items: Readonly<Record<string, Item>>,
): string[] => {
  const out: string[] = [];

  for (const id of order) {
    const item = items[id];

    if (!item || item.kind !== "agent_message" || item.status === "streaming" || seen.has(id)) continue;
    seen.add(id);

    if (item.status === "completed" && item.content.text.trim() !== "") out.push(id);
  }

  return out;
};

/** Plain text for a screen reader: markdown markers removed, at most `max` characters. */
export const announceText = (markdown: string, max = 400): string => {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
};

export const isKnownErrorCode = (code: string): code is ErrorCode =>
  ERROR_CODES.some((value) => value === code);

/** The error-table message for an error item's code, with the agent's name filled in. */
export const errorItemMessage = (code: string, agent?: AgentId): string =>
  errorMessage(isKnownErrorCode(code) ? code : "INTERNAL", agent);

export type ToolIcon =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

const TOOL_ICONS = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
] as const;

/** ACP ToolKind to an icon; unknown kinds use the generic one. */
export const toolIcon = (toolKind: string | null | undefined): ToolIcon =>
  Schema.is(Schema.Literals(TOOL_ICONS))(toolKind) ? toolKind : "other";

/** Paths inside the container are absolute under /workspace; file tabs take repo-relative paths. */
export const workspacePath = (path: string): string => {
  if (path === "/workspace") return "";

  if (path.startsWith("/workspace/")) return path.slice("/workspace/".length);

  if (path.startsWith("file:///workspace/")) return path.slice("file:///workspace/".length);

  return path;
};

/** `file:///workspace/<path>#L<n>` (or `:n`) as a file tab target. */
export const fileLinkTarget = (
  href: string,
): { readonly path: string; readonly line: number | null } | null => {
  if (!href.startsWith("file:///workspace/")) return null;
  let rest = href.slice("file:///workspace/".length);
  let line: number | null = null;
  const hash = /#L(\d+)(?:-L?\d+)?$/.exec(rest);

  if (hash) {
    line = Number(hash[1]);
    rest = rest.slice(0, hash.index);
  }

  try {
    rest = decodeURIComponent(rest);
  } catch {
    return null;
  }

  if (!rest || rest.split("/").some((part) => !part || part === "." || part === "..") || /\p{Cc}/u.test(rest))
    return null;

  return { path: rest, line };
};

export const locationLabel = (loc: { readonly path: string; readonly line?: number | null }): string => {
  const p = workspacePath(loc.path) || loc.path;

  return loc.line != null ? `${p}:${loc.line}` : p;
};

/** The first option whose ACP kind is allow_* or reject_* (04: Enter and ⌫ on a permission card). */
export const firstPermissionOption = (
  options: ReadonlyArray<PermissionOption>,
  kind: "allow" | "reject",
): PermissionOption | undefined => options.find((o) => o.kind.startsWith(`${kind}_`) || o.kind === kind);

export const isPermissionAnswered = (item: ItemOf<"permission">): boolean =>
  (item.content.chosenOptionId ?? null) !== null ||
  item.status === "completed" ||
  item.status === "cancelled" ||
  item.status === "failed";

export type BlockView =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly src: string; readonly alt: string }
  | { readonly kind: "audio"; readonly src: string }
  | { readonly kind: "link"; readonly uri: string; readonly name: string }
  | { readonly kind: "resource"; readonly uri: string; readonly text: string | null }
  | { readonly kind: "unknown"; readonly type: string };

const str = Schema.decodeUnknownSync(
  Schema.Unknown.pipe(
    Schema.decodeTo(Schema.NullOr(Schema.String), {
      decode: SchemaGetter.transform((value) => (Schema.is(Schema.String)(value) ? value : null)),
      encode: SchemaGetter.passthrough(),
    }),
  ),
);

const SAFE_IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp)$/i;

const SAFE_AUDIO = /^audio\/[a-z0-9.+-]+$/i;

/**
 * How one ACP ContentBlock renders. Inline image data is fine (05); an image given only by a
 * remote URI becomes a link and is never loaded.
 */
export const blockView = (block: AcpFields): BlockView => {
  const type = str(block["type"]) ?? "";

  switch (type) {
    case "text":
      return { kind: "text", text: str(block["text"]) ?? "" };
    case "image": {
      const data = str(block["data"]);
      const mime = str(block["mimeType"]) ?? "";
      const uri = str(block["uri"]);

      if (data && SAFE_IMAGE.test(mime))
        return { kind: "image", src: `data:${mime};base64,${data}`, alt: uri ?? "Image" };

      return uri ? { kind: "link", uri, name: uri } : { kind: "unknown", type: "image" };
    }

    case "audio": {
      const data = str(block["data"]);
      const mime = str(block["mimeType"]) ?? "";

      return data && SAFE_AUDIO.test(mime)
        ? { kind: "audio", src: `data:${mime};base64,${data}` }
        : { kind: "unknown", type: "audio" };
    }

    case "resource_link": {
      const uri = str(block["uri"]) ?? "";

      return { kind: "link", uri, name: str(block["title"]) ?? str(block["name"]) ?? uri };
    }

    case "resource": {
      const r = block["resource"];
      const res = Schema.is(AcpFields)(r) ? r : {};

      return { kind: "resource", uri: str(res["uri"]) ?? "", text: str(res["text"]) };
    }

    default:
      return { kind: "unknown", type };
  }
};

export type ToolContentView =
  | { readonly kind: "block"; readonly block: BlockView }
  | { readonly kind: "diff"; readonly path: string; readonly oldText: string; readonly newText: string }
  | { readonly kind: "terminal"; readonly terminalId: string };

export const toolContentView = (c: AcpFields): ToolContentView => {
  if (c["type"] === "diff") {
    return {
      kind: "diff",
      path: str(c["path"]) ?? "",
      oldText: str(c["oldText"]) ?? "",
      newText: str(c["newText"]) ?? "",
    };
  }

  if (c["type"] === "terminal") return { kind: "terminal", terminalId: str(c["terminalId"]) ?? "" };

  if (c["type"] === "content") {
    const inner = c["content"];

    if (Schema.is(AcpFields)(inner)) {
      return { kind: "block", block: blockView(inner) };
    }
  }

  return { kind: "block", block: blockView(c) };
};

export interface UnifiedHunk {
  readonly header: string;
  readonly lines: ReadonlyArray<DiffLine>;
}

/** Collapses a full line diff to unified hunks with `context` lines around each change. */
export const toUnifiedHunks = (lines: ReadonlyArray<DiffLine>, context = 3): UnifiedHunk[] => {
  const changed: number[] = [];
  lines.forEach((l, i) => {
    if (l.kind !== "context") changed.push(i);
  });

  if (changed.length === 0) return [];
  const ranges: Array<[number, number]> = [];

  for (const i of changed) {
    const lo = Math.max(0, i - context);
    const hi = Math.min(lines.length - 1, i + context);
    const prev = ranges[ranges.length - 1];

    if (prev && lo <= prev[1] + 1) prev[1] = Math.max(prev[1], hi);
    else ranges.push([lo, hi]);
  }

  return ranges.map(([lo, hi]) => {
    const slice = lines.slice(lo, hi + 1);
    const oldLines = slice.filter((l) => l.kind !== "add");
    const newLines = slice.filter((l) => l.kind !== "del");

    const oldStart =
      oldLines[0]?.oldLine ?? Math.max(0, (slice.find((l) => l.oldLine !== null)?.oldLine ?? 1) - 1);

    const newStart =
      newLines[0]?.newLine ?? Math.max(0, (slice.find((l) => l.newLine !== null)?.newLine ?? 1) - 1);

    return {
      header: `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
      lines: slice,
    };
  });
};

/** The plan entry counts for the `Plan 3/4` pill. */
export const planProgress = (entries: ReadonlyArray<{ readonly status: string }>) =>
  ({
    done: entries.filter((e) => e.status === "completed").length,
    total: entries.length,
  }) satisfies { done: number; total: number };

/** Stop reasons and turn statuses worth a word in the turn footer. */
export const turnOutcome = (turn: Pick<Turn, "status" | "stopReason">): string | null => {
  switch (turn.status) {
    case "cancelled":
      return "Stopped";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    default:
      if (turn.stopReason === "max_tokens") return "Hit the token limit";

      if (turn.stopReason === "max_turn_requests") return "Hit the request limit";

      if (turn.stopReason === "refusal") return "The agent refused";

      return null;
  }
};

export const turnDuration = (turn: Pick<Turn, "startedAt" | "endedAt">): number | null =>
  turn.startedAt !== null && turn.endedAt !== null ? Math.max(0, turn.endedAt - turn.startedAt) : null;

/** The footer's token text, from the usage the agent reported for this turn. */
export const turnTokens = (turn: Pick<Turn, "usage">): string | null => {
  const u = turn.usage;

  if (!u) return null;

  return `${formatTokens(u.totalTokens)} tokens (${formatTokens(u.inputTokens)} in, ${formatTokens(u.outputTokens)} out)`;
};
