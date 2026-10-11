import { ChevronDownIcon, ChevronRightIcon, FileIcon, FolderIcon, SearchIcon } from "lucide-react";
import { useCallback, useMemo, type KeyboardEvent } from "react";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { ShortcutKbd } from "~/ui/components/ui/kbd";
import { LoadingText } from "~/ui/components/ui/spinner";
import { useWorkspaceUiSelector } from "~/ui/hooks/useWorkspaceUi";
import { errorCode } from "~/ui/lib/toast";
import { openDialog, openFile, type WorkspaceUiState } from "~/ui/state/workspace-ui";
import { isComingUp } from "./changes-model";
import { buildTree, parentRowIndex, treeRows, type TreeRow } from "./file-tree";
import { ListBox } from "./ListBox";
import { WakeButton } from "./parts";
import { useFileList, useRememberedSet, useWorkspaceStateValue } from "./use-review";
import { ERROR_MESSAGES } from "@tempo/protocol";

const rowKey = (r: TreeRow) => `${r.kind}:${r.path}`;

const activeFilePath = (s: WorkspaceUiState): string | null => {
  const t = s.tabs.find((x) => x.key === s.activeKey);
  return t?.tab.kind === "file" ? t.tab.path : null;
};

/** 04, All files tab: a tree from listFiles; a click opens a read-only file tab. */
export function FilesView({ workspaceId }: { workspaceId: string }) {
  const state = useWorkspaceStateValue(workspaceId);
  const { query, live } = useFileList(workspaceId);
  const tree = useMemo(() => buildTree(query.data?.paths ?? []), [query.data]);
  const [expanded, setExpanded] = useRememberedSet(`files:${workspaceId}`);
  const rows = useMemo(() => treeRows(tree, expanded), [tree, expanded]);
  const openPath = useWorkspaceUiSelector(workspaceId, activeFilePath);

  const setOpen = useCallback(
    (path: string, open: boolean) =>
      setExpanded((cur) => {
      if (cur.has(path) === open) return cur;
      const next = new Set(cur);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const activate = (row: TreeRow) => {
    if (row.kind === "dir") setOpen(row.path, !row.expanded);
    else openFile(workspaceId, row.path);
  };

  const onItemKey = (
    e: KeyboardEvent<HTMLDivElement>,
    row: TreeRow,
    index: number,
    moveTo: (i: number) => void,
  ): boolean => {
    if (e.key === "ArrowRight") {
      if (row.kind !== "dir") return false;
      if (row.expanded) moveTo(index + 1);
      else setOpen(row.path, true);
      return true;
    }
    if (e.key === "ArrowLeft") {
      if (row.kind === "dir" && row.expanded) {
        setOpen(row.path, false);
        return true;
      }
      const parent = parentRowIndex(rows, index);
      if (parent === null) return false;
      moveTo(parent);
      return true;
    }
    return false;
  };

  let body;
  if (!live) {
    body = isComingUp(state) ? (
      <div className="flex flex-1 items-center justify-center p-6">
        <LoadingText label={ERROR_MESSAGES.CONTAINER_NOT_READY} />
      </div>
    ) : (
      <div className="flex flex-1 items-center justify-center p-6">
        <WakeButton workspaceId={workspaceId} label="Wake to browse files" />
      </div>
    );
  } else if (query.isPending) {
    body = <SkeletonRows />;
  } else if (query.isError && !query.data) {
    body =
      errorCode(query.error) === "CONTAINER_NOT_READY" ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <LoadingText label={ERROR_MESSAGES.CONTAINER_NOT_READY} />
        </div>
      ) : (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      );
  } else if (rows.length === 0) {
    body = <EmptyState title="No files." />;
  } else {
    body = (
      <ListBox
        items={rows}
        getKey={rowKey}
        label="All files"
        role="tree"
        rowHeight={24}
        activeKey={openPath ? `file:${openPath}` : null}
        onActivate={activate}
        onItemKey={onItemKey}
        itemAria={(r) =>
          r.kind === "dir"
            ? { "aria-level": r.depth + 1, "aria-expanded": r.expanded }
            : { "aria-level": r.depth + 1 }
        }
        renderItem={(r) => <TreeRowView row={r} current={r.kind === "file" && r.path === openPath} />}
        className="flex-1"
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={!live}
          onClick={() => openDialog({ kind: "openFile", workspaceId })}
        >
          <FileIcon />
          Open file
          <ShortcutKbd action="openFile" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!live}
          onClick={() => openDialog({ kind: "searchFiles", workspaceId })}
        >
          <SearchIcon />
          Search
          <ShortcutKbd action="searchFiles" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
    </div>
  );
}

function TreeRowView({ row, current }: { row: TreeRow; current: boolean }) {
  const indent = { paddingLeft: `${row.depth * 12}px` };
  if (row.kind === "dir") {
    const Chevron = row.expanded ? ChevronDownIcon : ChevronRightIcon;
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1" style={indent}>
        <Chevron aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate" title={row.path}>
          {row.name}
        </span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1" style={indent}>
      <span aria-hidden className="size-3.5 shrink-0" />
      <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className={current ? "truncate font-medium" : "truncate"} title={row.path}>
        {row.name}
      </span>
    </span>
  );
}
