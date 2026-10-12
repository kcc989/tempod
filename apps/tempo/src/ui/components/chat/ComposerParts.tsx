import type { ConfigOption, Session, Turn } from "@tempo/protocol";
import {
  ChevronDownIcon,
  ClockIcon,
  FileIcon,
  KeyRoundIcon,
  ListChecksIcon,
  MessageSquareIcon,
  PaperclipIcon,
  SlashIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode, type Ref } from "react";
import { Button } from "~/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/ui/components/ui/dropdown-menu";
import { ShortcutKbd } from "~/ui/components/ui/kbd";
import { Spinner } from "~/ui/components/ui/spinner";
import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { formatBytes, formatTokens } from "~/ui/lib/format";
import { cn } from "~/ui/lib/utils";
import { openDialog } from "~/ui/state/workspace-ui";
import {
  chipLabel,
  currentValueLabel,
  optionGroups,
  reviewChipLabel,
  type ContextUsage,
  type SlashEntry,
} from "./composer-model";

export interface PendingAttachment {
  readonly localId: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly preview: string | undefined;
  readonly status: "uploading" | "ready" | "failed";
  readonly attachmentId: string | undefined;
}

/** Missing login or a login that stopped working (04, Empty, loading and error states). */
export function LoginBanner({ text }: { text: string }) {
  return (
    <div role="alert" className="flex items-center gap-2 border-t bg-warning/10 px-3 py-1.5 text-sm">
      <KeyRoundIcon className="size-3.5 shrink-0 text-warning" />
      <span className="min-w-0 flex-1">{text}</span>
      <Button size="sm" variant="outline" onClick={() => openDialog({ kind: "settings", tab: "logins" })}>
        Add login
      </Button>
    </div>
  );
}

function Chip({
  icon,
  children,
  onRemove,
  removeLabel,
  className,
}: {
  icon: ReactNode;
  children: ReactNode;
  onRemove?: () => void;
  removeLabel: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 max-w-64 items-center gap-1 rounded-md border bg-background pr-0.5 pl-1.5 text-xs",
        className,
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
      {onRemove && (
        <Button size="icon-sm" variant="ghost" className="size-5" aria-label={removeLabel} onClick={onRemove}>
          <XIcon className="size-3" />
        </Button>
      )}
    </span>
  );
}

export function MentionChip({ path, onRemove }: { path: string; onRemove: () => void }) {
  return (
    <Chip
      icon={<FileIcon className="size-3 shrink-0 text-muted-foreground" />}
      onRemove={onRemove}
      removeLabel={`Remove ${path}`}
    >
      {path}
    </Chip>
  );
}

export function ReviewChip({ count, onRemove }: { count: number; onRemove: () => void }) {
  return (
    <Chip
      icon={<MessageSquareIcon className="size-3 shrink-0 text-muted-foreground" />}
      onRemove={onRemove}
      removeLabel="Remove review comments"
    >
      {reviewChipLabel(count)}
    </Chip>
  );
}

export function AttachmentChip({ a, onRemove }: { a: PendingAttachment; onRemove: () => void }) {
  const icon =
    a.status === "uploading" ? (
      <Spinner aria-label="Uploading" className="size-3" />
    ) : a.preview ? (
      <img src={a.preview} alt="" className="size-4 shrink-0 rounded-sm object-cover" />
    ) : (
      <PaperclipIcon className="size-3 shrink-0 text-muted-foreground" />
    );
  return (
    <Chip
      icon={icon}
      onRemove={onRemove}
      removeLabel={`Remove ${a.name}`}
      className={cn(a.status === "failed" && "border-destructive/60 text-destructive")}
    >
      <span title={`${a.name}, ${formatBytes(a.size)}`}>
        {a.name}
        {a.status === "failed" && " · Upload failed; attach again"}
      </span>
    </Chip>
  );
}

/** A queued prompt: click to edit, × to delete, drag or ⌥← and ⌥→ to reorder. */
export function QueuedChip({
  turn,
  onSave,
  onDelete,
  onMove,
  onDragStart,
  onDrop,
}: {
  turn: Turn;
  onSave: (text: string) => void;
  onDelete: () => void;
  onMove: (delta: -1 | 1) => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  if (turn.steeringPending) {
    return (
      <span role="status" className="rounded-md border bg-muted/50 px-1.5 py-1 text-xs">
        Sending now: {turn.prompt.text}
      </span>
    );
  }
  const save = () => {
    if (editing !== null && editing.trim() !== "" && editing !== turn.prompt.text) onSave(editing);
    setEditing(null);
  };
  if (editing !== null) {
    return (
      <input
        autoFocus
        aria-label="Edit queued message"
        value={editing}
        onChange={(e) => setEditing(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(null);
          }
        }}
        className="h-6 w-64 rounded-md border border-input bg-background px-1.5 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
    );
  }
  return (
    <span
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-tempo-turn", turn.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-tempo-turn")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("application/x-tempo-turn")) return;
        e.preventDefault();
        e.stopPropagation();
        onDrop();
      }}
      className="inline-flex h-6 max-w-72 cursor-grab items-center gap-1 rounded-md border border-dashed bg-muted/50 pr-0.5 pl-1.5 text-xs"
    >
      <ClockIcon className="size-3 shrink-0 text-muted-foreground" />
      <button
        type="button"
        title="Queued. Click to edit; ⌥← or ⌥→ to move."
        className="min-w-0 truncate rounded-sm text-left"
        onClick={() => setEditing(turn.prompt.text)}
        onKeyDown={(e) => {
          if (e.altKey && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
            e.preventDefault();
            onMove(e.code === "ArrowLeft" ? -1 : 1);
          }
        }}
      >
        {chipLabel(turn.prompt.text)}
      </button>
      <Button
        size="icon-sm"
        variant="ghost"
        className="size-5"
        aria-label="Delete queued message"
        onClick={onDelete}
      >
        <XIcon className="size-3" />
      </Button>
    </span>
  );
}

/** Used and total context from the agent's usage_update. */
export function ContextRing({ usage }: { usage: ContextUsage }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const pct = Math.round(usage.ratio * 100);
  const label = `${formatTokens(usage.used)} of ${formatTokens(usage.size)} tokens of context used (${pct}%)`;
  return (
    <SimpleTooltip label={label}>
      <span
        tabIndex={0}
        role="img"
        aria-label={label}
        className="inline-flex size-6 items-center justify-center rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <svg viewBox="0 0 16 16" className="size-4 -rotate-90">
          <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" className="stroke-muted" />
          <circle
            cx="8"
            cy="8"
            r={r}
            fill="none"
            strokeWidth="2"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - usage.ratio)}
            strokeLinecap="round"
            className={cn(
              usage.ratio >= 0.95
                ? "stroke-destructive"
                : usage.ratio >= 0.8
                  ? "stroke-warning"
                  : "stroke-primary",
            )}
          />
        </svg>
      </span>
    </SimpleTooltip>
  );
}

function SelectOptionItems({ option, onPick }: { option: ConfigOption; onPick: (value: string) => void }) {
  const groups = optionGroups(option);
  return (
    <DropdownMenuRadioGroup value={String(option.currentValue)} onValueChange={onPick}>
      {groups.map((g, i) => (
        <div key={`${g.name ?? ""}:${i}`}>
          {i > 0 && <DropdownMenuSeparator />}
          {g.name && <DropdownMenuLabel>{g.name}</DropdownMenuLabel>}
          {g.values.map((v) => (
            <DropdownMenuRadioItem key={v.value} value={v.value}>
              {v.name}
            </DropdownMenuRadioItem>
          ))}
        </div>
      ))}
    </DropdownMenuRadioGroup>
  );
}

const pickerTrigger =
  "inline-flex h-7 max-w-36 items-center gap-1.5 rounded-lg px-1.5 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50";

/** Model picker (⌘/) from the agent's `model` config option; set with setSessionConfig. */
export function ModelPicker({
  option,
  open,
  onOpenChange,
  disabled,
  onPick,
  onClosed,
}: {
  option: ConfigOption;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  onPick: (value: string) => void;
  onClosed: () => void;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        className={cn(pickerTrigger, "text-foreground")}
        disabled={disabled}
        aria-label={`Model: ${currentValueLabel(option)}`}
      >
        <span className="truncate">{currentValueLabel(option)}</span>
        <ChevronDownIcon className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        className="max-h-80 min-w-48"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          onClosed();
        }}
      >
        <DropdownMenuLabel className="flex items-center justify-between gap-4">
          {option.name || "Model"}
          <ShortcutKbd action="modelPicker" />
        </DropdownMenuLabel>
        <SelectOptionItems option={option} onPick={onPick} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Mode picker from the agent's modes (or its `mode` config option when it reports no modes). */
export function ModePicker({
  session,
  modeOption,
  disabled,
  onMode,
  onConfig,
  onClosed,
}: {
  session: Session;
  modeOption: ConfigOption | undefined;
  disabled: boolean;
  onMode: (modeId: string) => void;
  onConfig: (option: ConfigOption, value: string) => void;
  onClosed: () => void;
}) {
  if (session.modes.length === 0 && !modeOption) return null;
  const current =
    session.modes.length > 0
      ? (session.modes.find((m) => m.id === session.modeId)?.name ?? session.modeId ?? "Mode")
      : currentValueLabel(modeOption!);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={pickerTrigger} disabled={disabled} aria-label={`Mode: ${current}`}>
        <span className="truncate">{current}</span>
        <ChevronDownIcon className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        className="max-h-80 min-w-48"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          onClosed();
        }}
      >
        <DropdownMenuLabel>Mode</DropdownMenuLabel>
        {session.modes.length > 0 ? (
          <DropdownMenuRadioGroup value={session.modeId ?? ""} onValueChange={onMode}>
            {session.modes.map((m) => (
              <DropdownMenuRadioItem key={m.id} value={m.id}>
                <span className="flex flex-col">
                  {m.name}
                  {m.description && <span className="text-xs text-muted-foreground">{m.description}</span>}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        ) : (
          <SelectOptionItems option={modeOption!} onPick={(v) => onConfig(modeOption!, v)} />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The agent's other config options (for example reasoning effort). */
export function OptionsMenu({
  options,
  disabled,
  onConfig,
  onClosed,
}: {
  options: ReadonlyArray<ConfigOption>;
  disabled: boolean;
  onConfig: (option: ConfigOption, value: string | boolean) => void;
  onClosed: () => void;
}) {
  if (options.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={pickerTrigger} disabled={disabled} aria-label="Agent options">
        <SlidersHorizontalIcon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        className="min-w-48"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          onClosed();
        }}
      >
        {options.map((o) =>
          o.type === "boolean" ? (
            <DropdownMenuCheckboxItem
              key={o.id}
              checked={o.currentValue === true}
              onCheckedChange={(v) => onConfig(o, v === true)}
            >
              {o.name}
            </DropdownMenuCheckboxItem>
          ) : (
            <DropdownMenuSub key={o.id}>
              <DropdownMenuSubTrigger>
                <span className="flex-1">{o.name}</span>
                <span className="text-xs text-muted-foreground">{currentValueLabel(o)}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80">
                <SelectOptionItems option={o} onPick={(v) => onConfig(o, v)} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type PickerRow =
  | { readonly kind: "file"; readonly key: string; readonly path: string }
  | { readonly kind: "command"; readonly key: string; readonly entry: SlashEntry };

/** The `@` file picker or the `/` command menu, above the text box. */
export function PickerList({
  id,
  rows,
  activeIndex,
  status,
  onPick,
  listRef,
  onRetry,
}: {
  id: string;
  rows: ReadonlyArray<PickerRow>;
  activeIndex: number;
  status: string | null;
  onPick: (index: number) => void;
  listRef?: Ref<HTMLDivElement>;
  onRetry?: () => void;
}) {
  return (
    <div
      ref={listRef}
      id={id}
      role="listbox"
      aria-label={rows[0]?.kind === "command" ? "Commands" : "Files"}
      className="absolute right-0 bottom-full left-0 z-20 mb-1 max-h-64 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {status && <p className="px-2 py-1 text-xs text-muted-foreground">{status}</p>}
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      )}
      {rows.map((row, i) => (
        <div
          key={row.key}
          id={`${id}-${i}`}
          role="option"
          aria-selected={i === activeIndex}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(i);
          }}
          className={cn(
            "flex cursor-default items-center gap-2 rounded-sm px-2 py-1 text-sm",
            i === activeIndex && "bg-accent text-accent-foreground",
          )}
        >
          {row.kind === "file" ? (
            <>
              <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-xs">{row.path}</span>
            </>
          ) : (
            <>
              <SlashIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 font-mono text-xs">{row.entry.name}</span>
              <span className="truncate text-xs text-muted-foreground">{row.entry.description}</span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

export function PlanPill({ progress }: { progress: string }) {
  return (
    <span className="inline-flex h-5 items-center rounded-md bg-primary/10 px-1.5 text-xs font-medium text-primary">
      Plan {progress}
    </span>
  );
}

export function PlanModeBadge() {
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-md bg-warning/15 px-1.5 text-xs font-medium text-warning">
      <ListChecksIcon className="size-3" />
      Plan mode
    </span>
  );
}
