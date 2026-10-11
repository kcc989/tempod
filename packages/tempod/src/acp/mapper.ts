import type {
  AvailableCommand,
  ConfigOption,
  ItemKind,
  ItemStatus,
  PermissionOption,
  SessionMode,
  SessionPatch,
  TempodEvent,
} from "@tempo/protocol";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundContent, offloadBlobs, splitText, type SaveBlob } from "../bounds.ts";
import { errorText, type Logger } from "../log.ts";
import { isObj, stripMeta, toCommands, toConfigOptions } from "./convert.ts";

type Obj = Record<string, unknown>;

export interface ItemRec {
  readonly id: string;
  readonly kind: ItemKind;
  status: ItemStatus;
  content: Obj;
}

export interface SessionState {
  modeId: string | null;
  modes: SessionMode[];
  configOptions: ConfigOption[];
  commands: AvailableCommand[];
}

export type TurnOutcome = "completed" | "cancelled" | "failed" | "interrupted";

export interface MapperDeps {
  readonly emit: (event: TempodEvent) => void;
  readonly log: Logger;
  readonly newId: () => string;
  readonly now?: () => number;
  readonly mergeMs: number;
  readonly maxBytes: number;
  /** Where large inline images go (`/home/tempo/attachments`); without it they are replaced by a marker. */
  readonly attachments?: string;
}

const EXTENSIONS: Record<string, string> = { jpeg: "jpg", "svg+xml": "svg", mpeg: "mp3" };

const extensionFor = (mime: string | null): string => {
  const sub = (mime ?? "").split("/")[1]?.split(";")[0]?.trim().toLowerCase() ?? "";
  const clean = sub.replace(/[^a-z0-9+.-]/g, "");
  return EXTENSIONS[clean] ?? (clean.replace(/[^a-z0-9]/g, "") || "bin");
};

const TOOL_STATUSES: ReadonlyArray<ItemStatus> = ["pending", "in_progress", "completed", "failed"];
const OPEN: ReadonlyArray<ItemStatus> = ["streaming", "pending", "in_progress"];

const noticeLevel = (s: unknown): "info" | "warning" | "error" =>
  s === "warning" || s === "error" ? s : "info";

const toLocations = (u: unknown): Obj[] =>
  Array.isArray(u)
    ? u
        .filter(isObj)
        .flatMap((l) =>
          typeof l["path"] === "string"
            ? [typeof l["line"] === "number" ? { path: l["path"], line: l["line"] } : { path: l["path"] }]
            : [],
        )
    : [];

const toPermissionOptions = (u: unknown): PermissionOption[] =>
  Array.isArray(u)
    ? u.filter(isObj).flatMap((o) =>
        typeof o["optionId"] === "string"
          ? [
              {
                optionId: o["optionId"],
                name: typeof o["name"] === "string" ? o["name"] : o["optionId"],
                kind: String(o["kind"] ?? ""),
              },
            ]
          : [],
      )
    : [];

/**
 * ACP `session/update` to Tempo items (02, ACP update to item) for one session. Text chunks for the same
 * item are merged into one `item.delta` per `mergeMs` or `maxBytes`; any other update first flushes them.
 */
export class SessionMapper {
  turnId: string | null = null;
  private items: ItemRec[] = [];
  private readonly byId = new Map<string, ItemRec>();
  private readonly tools = new Map<string, ItemRec>();
  private plan: ItemRec | null = null;
  private pending: { item: ItemRec; text: string; bytes: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly state: SessionState = { modeId: null, modes: [], configOptions: [], commands: [] };

  constructor(
    readonly sessionId: string,
    private readonly deps: MapperDeps,
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private emit(event: TempodEvent): void {
    this.deps.emit(event);
  }

  startTurn(turnId: string): void {
    this.flush();
    this.turnId = turnId;
    this.items = [];
    this.byId.clear();
    this.tools.clear();
    this.plan = null;
  }

  get turnItems(): ReadonlyArray<ItemRec> {
    return this.items;
  }

  /** Closes the turn's items: streaming text completes; on a non-completed end every open item is cancelled. */
  endTurn(outcome: TurnOutcome): void {
    this.flush();
    for (const item of this.items) {
      let next: ItemStatus | null = null;
      if (outcome !== "completed" && OPEN.includes(item.status)) next = "cancelled";
      else if (item.status === "streaming") next = "completed";
      else if (item.kind === "permission" && item.status === "pending") next = "cancelled";
      if (next && next !== item.status) this.setStatus(item, next);
    }
    this.turnId = null;
    this.items = [];
    this.byId.clear();
    this.tools.clear();
    this.plan = null;
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    for (const text of splitText(p.text)) {
      this.emit({ kind: "item.delta", sessionId: this.sessionId, itemId: p.item.id, append: { text } });
    }
  }

  /** Saves a large inline blob under attachments/<turnId>/ and returns its link (02: messages stay under 1 MiB). */
  private readonly saveBlob: SaveBlob = (data, mimeType) => {
    const root = this.deps.attachments;
    if (!root) return null;
    try {
      const dir = join(root, this.turnId ?? "none");
      mkdirSync(dir, { recursive: true });
      const name = `tool-${randomBytes(6).toString("hex")}.${extensionFor(mimeType)}`;
      const path = join(dir, name);
      writeFileSync(path, Buffer.from(data, "base64"));
      return { uri: `file://${path}`, name };
    } catch (e) {
      this.deps.log.warn("could not save a large image", { sessionId: this.sessionId, error: errorText(e) });
      return null;
    }
  };

  private offload<A>(value: A): A {
    return offloadBlobs(value, this.saveBlob) as A;
  }

  private setStatus(item: ItemRec, status: ItemStatus): void {
    item.status = status;
    this.emit({ kind: "item.updated", sessionId: this.sessionId, itemId: item.id, patch: { status } });
  }

  private updated(item: ItemRec, status?: ItemStatus): void {
    const patch: { status?: ItemStatus; content: Obj } = {
      content: boundContent(structuredClone(item.content)),
    };
    if (status !== undefined && status !== item.status) {
      item.status = status;
      patch.status = status;
    }
    this.emit({ kind: "item.updated", sessionId: this.sessionId, itemId: item.id, patch });
  }

  private create(kind: ItemKind, status: ItemStatus, content: Obj): ItemRec {
    this.flush();
    const last = this.items[this.items.length - 1];
    if (last && last.status === "streaming") this.setStatus(last, "completed");
    const item: ItemRec = { id: this.deps.newId(), kind, status, content };
    this.items.push(item);
    this.byId.set(item.id, item);
    this.emit({
      kind: "item.created",
      sessionId: this.sessionId,
      turnId: this.turnId,
      item: {
        id: item.id,
        kind,
        status,
        content: boundContent(structuredClone(content)),
        createdAt: this.now(),
      },
    });
    return item;
  }

  private sessionPatch(patch: SessionPatch): void {
    this.flush();
    this.emit({ kind: "session.updated", sessionId: this.sessionId, patch });
  }

  /** Applies session-level fields of an update without emitting (used while `session/load` replays). */
  captureState(update: unknown): void {
    if (!isObj(update)) return;
    switch (update["sessionUpdate"]) {
      case "available_commands_update":
        this.state.commands = toCommands(update["availableCommands"]);
        break;
      case "current_mode_update":
        if (typeof update["currentModeId"] === "string") this.state.modeId = update["currentModeId"];
        break;
      case "config_option_update":
        this.state.configOptions = toConfigOptions(update["configOptions"]);
        break;
    }
  }

  handle(update: unknown): void {
    if (!isObj(update) || typeof update["sessionUpdate"] !== "string") {
      this.deps.log.warn("malformed session/update dropped", { sessionId: this.sessionId });
      return;
    }
    const kind = update["sessionUpdate"];
    switch (kind) {
      case "user_message_chunk":
        return;
      case "agent_message_chunk":
        return this.chunk("agent_message", update["content"]);
      case "agent_thought_chunk":
        return this.chunk("agent_thought", update["content"]);
      case "tool_call":
      case "tool_call_update":
        return this.toolCall(update, kind === "tool_call");
      case "plan":
        return this.planUpdate(update);
      case "available_commands_update":
        this.captureState(update);
        return this.sessionPatch({ commands: this.state.commands });
      case "current_mode_update":
        this.captureState(update);
        return this.sessionPatch({ modeId: this.state.modeId });
      case "config_option_update":
        this.captureState(update);
        return this.sessionPatch({ configOptions: this.state.configOptions });
      case "session_info_update":
        if (typeof update["title"] === "string") this.sessionPatch({ title: update["title"] });
        return;
      case "usage_update":
        return this.sessionPatch({ usage: stripMeta(update, "sessionUpdate") });
      case "notice":
        return this.notice(update);
      default:
        this.deps.log.warn("unsupported session/update dropped", { sessionId: this.sessionId, update: kind });
    }
  }

  private needTurn(what: string): boolean {
    if (this.turnId !== null) return true;
    this.deps.log.warn("session/update outside a turn dropped", { sessionId: this.sessionId, update: what });
    return false;
  }

  private chunk(kind: "agent_message" | "agent_thought", block: unknown): void {
    if (!this.needTurn(kind)) return;
    if (!isObj(block) || typeof block["type"] !== "string") return;
    const last = this.items[this.items.length - 1];
    const open = last && last.kind === kind && last.status === "streaming" ? last : null;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      const text = block["text"];
      if (!open) {
        this.create(kind, "streaming", { text });
        return;
      }
      open.content["text"] = String(open.content["text"] ?? "") + text;
      this.appendDelta(open, text);
      return;
    }
    if (kind === "agent_thought") {
      this.deps.log.debug("non-text thought content dropped", { sessionId: this.sessionId });
      return;
    }
    const content = this.offload(stripMeta(block));
    if (!open) {
      this.create(kind, "streaming", { text: "", blocks: [content] });
      return;
    }
    this.flush();
    const blocks = Array.isArray(open.content["blocks"]) ? (open.content["blocks"] as unknown[]) : [];
    open.content["blocks"] = [...blocks, content];
    this.updated(open);
  }

  private appendDelta(item: ItemRec, text: string): void {
    if (this.pending && this.pending.item !== item) this.flush();
    if (!this.pending) {
      this.pending = { item, text: "", bytes: 0 };
      this.timer = setTimeout(() => this.flush(), this.deps.mergeMs);
    }
    this.pending.text += text;
    this.pending.bytes += Buffer.byteLength(text);
    if (this.pending.bytes >= this.deps.maxBytes) this.flush();
  }

  private toolCall(u: Obj, isNew: boolean): void {
    if (!this.needTurn(String(u["sessionUpdate"]))) return;
    const toolCallId = typeof u["toolCallId"] === "string" ? u["toolCallId"] : null;
    if (toolCallId === null) return;
    const status = TOOL_STATUSES.includes(u["status"] as ItemStatus)
      ? (u["status"] as ItemStatus)
      : undefined;
    const existing = this.tools.get(toolCallId);
    if (!existing) {
      if (!isNew)
        this.deps.log.debug("tool_call_update for an unknown tool call", { sessionId: this.sessionId });
      const content: Obj = {
        toolCallId,
        title: typeof u["title"] === "string" ? u["title"] : "",
        toolKind: typeof u["kind"] === "string" ? u["kind"] : null,
        locations: toLocations(u["locations"]),
        content: Array.isArray(u["content"]) ? this.offload(u["content"]) : [],
      };
      if (u["rawInput"] !== undefined) content["rawInput"] = u["rawInput"];
      if (u["rawOutput"] !== undefined) content["rawOutput"] = u["rawOutput"];
      const item = this.create("tool_call", status ?? "pending", content);
      this.tools.set(toolCallId, item);
      return;
    }
    this.flush();
    const c = existing.content;
    if (typeof u["title"] === "string") c["title"] = u["title"];
    if (typeof u["kind"] === "string") c["toolKind"] = u["kind"];
    if (Array.isArray(u["locations"])) c["locations"] = toLocations(u["locations"]);
    if (Array.isArray(u["content"])) c["content"] = this.offload(u["content"]);
    if (u["rawInput"] !== undefined && u["rawInput"] !== null) c["rawInput"] = u["rawInput"];
    if (u["rawOutput"] !== undefined && u["rawOutput"] !== null) c["rawOutput"] = u["rawOutput"];
    this.updated(existing, status);
  }

  private planUpdate(u: Obj): void {
    if (!this.needTurn("plan")) return;
    const entries = Array.isArray(u["entries"])
      ? u["entries"].filter(isObj).map((e) => ({
          content: String(e["content"] ?? ""),
          priority: String(e["priority"] ?? "medium"),
          status: String(e["status"] ?? "pending"),
        }))
      : [];
    const status: ItemStatus =
      entries.length > 0 && entries.every((e) => e.status === "completed") ? "completed" : "in_progress";
    if (!this.plan) {
      this.plan = this.create("plan", status, { entries });
      return;
    }
    this.flush();
    this.plan.content["entries"] = entries;
    this.updated(this.plan, status);
  }

  private notice(u: Obj): void {
    const title = typeof u["title"] === "string" ? u["title"] : "";
    const description = typeof u["description"] === "string" && u["description"] ? u["description"] : "";
    const text = description ? (title ? `${title}\n${description}` : description) : title;
    this.create("notice", "completed", { level: noticeLevel(u["severity"]), text });
  }

  /** Creates the `permission` item for a `session/request_permission` (01, Permission requests). */
  addPermission(
    requestId: string,
    toolCall: unknown,
    options: unknown,
  ): { itemId: string; title: string; options: PermissionOption[] } {
    const tc = isObj(toolCall) ? toolCall : {};
    const toolCallId = typeof tc["toolCallId"] === "string" ? tc["toolCallId"] : null;
    const known = toolCallId ? this.tools.get(toolCallId) : undefined;
    const title =
      typeof tc["title"] === "string" && tc["title"]
        ? tc["title"]
        : String(known?.content["title"] ?? "Permission");
    const opts = toPermissionOptions(options);
    const item = this.create("permission", "pending", { requestId, toolCallId, title, options: opts });
    return { itemId: item.id, title, options: opts };
  }

  resolvePermission(itemId: string, optionId: string | null): void {
    const item = this.byId.get(itemId);
    if (!item || item.status !== "pending") return;
    this.flush();
    item.content["chosenOptionId"] = optionId;
    this.updated(item, optionId === null ? "cancelled" : "completed");
  }
}
