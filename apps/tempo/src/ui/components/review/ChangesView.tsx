import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderTreeIcon,
  ExternalLinkIcon,
} from "lucide-react";
import { useCallback, useId, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { PrimaryActionButton } from "~/ui/components/topbar/PrimaryAction";
import { Button } from "~/ui/components/ui/button";
import { ShortcutKbd } from "~/ui/components/ui/kbd";
import { Label } from "~/ui/components/ui/label";
import { Spinner } from "~/ui/components/ui/spinner";
import { Textarea } from "~/ui/components/ui/textarea";
import { Toggle } from "~/ui/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "~/ui/components/ui/toggle-group";
import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { useCallMutation } from "~/ui/hooks/useCall";
import { useProject } from "~/ui/hooks/useProjects";
import { githubUrlFor } from "~/ui/components/topbar/topbar-logic";
import { useHubWorkspace } from "~/ui/hooks/useHub";
import { useLocalStorage } from "~/ui/hooks/useLocalStorage";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { useWorkspaceUiSelector } from "~/ui/hooks/useWorkspaceUi";
import { isMacPlatform, matchesCombo } from "~/ui/lib/shortcuts";
import { cn } from "~/ui/lib/utils";
import {
  openDiff,
  openGuide,
  setDiffScope,
  setPhonePane,
  type WorkspaceUiState,
} from "~/ui/state/workspace-ui";
import { changeRows, GROUP_BY_FOLDER_KEY, isBoolean, totals, type ChangeRow } from "./changes-model";
import { ListBox } from "./ListBox";
import { LineCounts, SourceNote, StatusLetter } from "./parts";
import { useChanges, useLive, useRememberedSet, type ChangesResult } from "./use-review";

const ROW_HEIGHT = 24;

const rowKey = (r: ChangeRow) => r.key;

const activeDiffPath = (s: WorkspaceUiState): string | null => {
  const t = s.tabs.find((x) => x.key === s.activeKey);

  return t?.tab.kind === "diff" ? t.tab.path : null;
};

/** 04, Changes tab. Phone: the file list with the primary git action at the top; a tap opens the diff. */
export function ChangesView({
  workspaceId,
  variant = "desktop",
}: {
  workspaceId: string;
  variant?: "desktop" | "phone";
}) {
  const phone = variant === "phone";
  const changes = useChanges(workspaceId);
  const workspace = useHubWorkspace(workspaceId);
  const pushed = useWorkspaceSelector(workspaceId, (s) => s.workspace?.pushed);
  const project = useProject(workspace?.projectId ?? "");
  const [grouped, setGrouped] = useLocalStorage(GROUP_BY_FOLDER_KEY, false, isBoolean);
  const [collapsed, setCollapsed] = useRememberedSet(`changes:${workspaceId}`);

  const rows = useMemo(
    () => changeRows(changes.files, { grouped, collapsed }),
    [changes.files, grouped, collapsed],
  );

  const sum = totals(changes.files);
  const openPath = useWorkspaceUiSelector(workspaceId, activeDiffPath);

  const toggleDir = useCallback(
    (dir: string, open?: boolean) => {
      setCollapsed((cur) => {
        const isOpen = !cur.has(dir);

        if (open !== undefined && open === isOpen) return cur;
        const next = new Set(cur);

        if (isOpen) next.add(dir);
        else next.delete(dir);

        return next;
      });
    },
    [setCollapsed],
  );

  const activate = (row: ChangeRow) => {
    if (row.kind === "folder") {
      toggleDir(row.dir);

      return;
    }

    openDiff(workspaceId, row.file.path);

    if (phone) setPhonePane("chat");
  };

  const onItemKey = (e: KeyboardEvent<HTMLDivElement>, row: ChangeRow) => {
    if (row.kind !== "folder") return false;

    if (e.key === "ArrowRight") toggleDir(row.dir, true);
    else if (e.key === "ArrowLeft") toggleDir(row.dir, false);
    else return false;

    return true;
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {phone && (
        <div className="flex shrink-0 items-center border-b p-2 empty:hidden">
          <PrimaryActionButton workspaceId={workspaceId} className="h-8 w-full" />
        </div>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-2 py-1.5">
        <ScopeToggle workspaceId={workspaceId} changes={changes} />
        {workspace && project && (
          <Button size="icon-sm" variant="ghost" asChild>
            <a
              href={githubUrlFor(project, workspace, pushed)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={project.provider === "artifacts" ? "Open repository" : "Open on GitHub"}
            >
              <ExternalLinkIcon />
            </a>
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            openGuide(workspaceId);

            if (phone) setPhonePane("chat");
          }}
        >
          Guide
        </Button>
        <SimpleTooltip label="Group by folder">
          <Toggle
            size="sm"
            aria-label="Group by folder"
            pressed={grouped}
            onPressedChange={(v) => setGrouped(v)}
          >
            <FolderTreeIcon />
          </Toggle>
        </SimpleTooltip>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {changes.fetching && changes.source === "live" && <Spinner className="size-3" />}
          {sum.files > 0 && (
            <>
              <span>{sum.files === 1 ? "1 file" : `${sum.files} files`}</span>
              <LineCounts additions={sum.additions} deletions={sum.deletions} />
            </>
          )}
        </span>
      </div>
      <SourceNote source={changes.source} />
      <div className="flex min-h-0 flex-1 flex-col">
        {!changes.hasList ? (
          changes.source === "error" ? (
            <ErrorState error={changes.error} onRetry={changes.refetch} />
          ) : (
            <SkeletonRows />
          )
        ) : rows.length === 0 ? (
          changes.source === "error" ? (
            <ErrorState error={changes.error} onRetry={changes.refetch} />
          ) : (
            <EmptyState title="No changes yet." />
          )
        ) : (
          <ListBox
            items={rows}
            getKey={rowKey}
            label="Changed files"
            role={grouped ? "tree" : "listbox"}
            rowHeight={phone ? 36 : ROW_HEIGHT}
            activeKey={openPath ? `file:${openPath}` : null}
            onActivate={activate}
            onItemKey={onItemKey}
            itemAria={(r) =>
              grouped
                ? r.kind === "folder"
                  ? { "aria-level": 1, "aria-expanded": !r.collapsed }
                  : { "aria-level": r.depth + 1 }
                : {}
            }
            renderItem={(r) => (
              <ChangeRowView row={r} current={r.kind === "file" && r.file.path === openPath} />
            )}
            className="flex-1"
          />
        )}
      </div>
      {!phone && <CommitFooter workspaceId={workspaceId} />}
    </div>
  );
}

function ChangeRowView({ row, current }: { row: ChangeRow; current: boolean }) {
  if (row.kind === "folder") {
    const Chevron = row.collapsed ? ChevronRightIcon : ChevronDownIcon;

    return (
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <Chevron aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={row.dir}>
          {row.dir}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">{row.count}</span>
      </span>
    );
  }

  const { file } = row;
  const title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;

  return (
    <span className={cn("flex min-w-0 flex-1 items-center gap-2", row.depth === 1 && "pl-5")}>
      <StatusLetter status={file.status} />
      <span
        title={title}
        className={cn("flex min-w-0 flex-1 items-baseline gap-1 truncate", current && "font-medium")}
      >
        {row.depth === 0 && row.dir !== "" ? (
          <>
            <span className="truncate text-muted-foreground">{row.dir}/</span>
            <span className="shrink-0">{row.label.slice(row.dir.length + 1)}</span>
          </>
        ) : (
          <span className="truncate">{row.label}</span>
        )}
      </span>
      <LineCounts additions={file.additions} deletions={file.deletions} />
    </span>
  );
}

/** Branch (against the merge base with origin/<base>) or Uncommitted (against HEAD). ⌥U switches. */
export function ScopeToggle({ workspaceId, changes }: { workspaceId: string; changes: ChangesResult }) {
  return (
    <SimpleTooltip
      label={
        <span className="inline-flex items-center gap-1.5">
          Branch or uncommitted
          <ShortcutKbd action="toggleScope" className="border-background/30 bg-transparent text-background" />
        </span>
      }
    >
      <ToggleGroup
        type="single"
        size="sm"
        aria-label="Diff scope"
        value={changes.scope}
        disabled={!changes.live}
        onValueChange={(v) => {
          if (v === "branch" || v === "uncommitted") setDiffScope(workspaceId, v);
        }}
      >
        <ToggleGroupItem value="branch" className="px-2">
          Branch
        </ToggleGroupItem>
        <ToggleGroupItem value="uncommitted" className="px-2">
          Uncommitted
        </ToggleGroupItem>
      </ToggleGroup>
    </SimpleTooltip>
  );
}

const SUBMIT = { code: "Enter", mod: true } as const;

/** 04, Changes tab footer: a commit message field and Commit and push. Empty uses the workspace title. */
function CommitFooter({ workspaceId }: { workspaceId: string }) {
  const id = useId();
  const [message, setMessage] = useState("");
  const live = useLive(workspaceId);
  const detailTitle = useWorkspaceSelector(workspaceId, (s) => s.workspace?.title);
  const summaryTitle = useHubWorkspace(workspaceId)?.title;

  const commit = useCallMutation("commitAndPush", {
    onSuccess: () => {
      toast.success("Committed and pushed.");
      setMessage("");
    },
  });

  const submit = (e?: FormEvent) => {
    e?.preventDefault();

    if (!live || commit.isPending) return;
    commit.mutate({ workspaceId, message: message.trim() });
  };

  return (
    <form onSubmit={submit} className="flex shrink-0 flex-col gap-1.5 border-t p-2">
      <Label htmlFor={id} className="sr-only">
        Commit message
      </Label>
      <Textarea
        id={id}
        rows={2}
        value={message}
        placeholder={detailTitle ?? summaryTitle ?? "Commit message"}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (!e.nativeEvent.isComposing && matchesCombo(e, SUBMIT, isMacPlatform())) {
            e.preventDefault();
            submit();
          }
        }}
        className="max-h-32 min-h-0 resize-none text-sm"
      />
      <Button type="submit" size="sm" disabled={!live || commit.isPending} className="self-end">
        {commit.isPending && <Spinner />}
        Commit and push
      </Button>
    </form>
  );
}
