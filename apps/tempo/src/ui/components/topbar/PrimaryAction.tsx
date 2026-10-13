import {
  ArchiveIcon,
  ArrowUpIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  ListChecksIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useState, type FormEvent, type ReactElement } from "react";
import { Button } from "~/ui/components/ui/button";
import { ShortcutKbd } from "~/ui/components/ui/kbd";
import { Label } from "~/ui/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "~/ui/components/ui/popover";
import { Spinner } from "~/ui/components/ui/spinner";
import { Textarea } from "~/ui/components/ui/textarea";
import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { useHubWorkspace } from "~/ui/hooks/useHub";
import { useProject } from "~/ui/hooks/useProjects";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import type { PrimaryActionKind } from "~/ui/lib/indicators";
import { githubChecksUrl } from "~/ui/lib/links";
import { isMacPlatform, matchesCombo } from "~/ui/lib/shortcuts";
import { cn } from "~/ui/lib/utils";
import {
  clearCommitRequest,
  commitRequestStore,
  isCommitRequested,
  takeCommitRequest,
} from "./commit-request";
import { PRIMARY_SHORTCUT, primaryEnabled, topPrimary, workspaceView } from "./topbar-logic";
import { useWorkspaceActions } from "./useWorkspaceActions";

const ICONS: Record<PrimaryActionKind, LucideIcon> = {
  commitPush: ArrowUpIcon,
  createPr: GitPullRequestIcon,
  viewChecks: ListChecksIcon,
  merge: GitMergeIcon,
  archive: ArchiveIcon,
};

/**
 * The one primary git action of a workspace (04, Primary action): Commit and push (opens a
 * message popover), Create PR, View checks, Merge (squash) or Archive. Renders nothing when no
 * row applies. Phones can place it at the top of Changes.
 */
export function PrimaryActionButton({ workspaceId, className }: { workspaceId: string; className?: string }) {
  const summary = useHubWorkspace(workspaceId);
  const detail = useWorkspaceSelector(workspaceId, (s) => s.workspace);
  const view = workspaceView(summary, detail);
  const project = useProject(view?.w.projectId);
  const actions = useWorkspaceActions(workspaceId);
  const [commitOpen, setCommitOpen] = useState(() => isCommitRequested(workspaceId));

  useEffect(
    () =>
      commitRequestStore.subscribe(() => {
        if (takeCommitRequest(workspaceId)) setCommitOpen(true);
      }),
    [workspaceId],
  );

  const onCommitOpenChange = (next: boolean) => {
    setCommitOpen(next);

    if (!next) clearCommitRequest(workspaceId);
  };

  const primary = view ? topPrimary(view) : null;

  if (!view || !primary) return null;

  const pending =
    (primary.kind === "commitPush" && actions.pending.commit) ||
    (primary.kind === "createPr" && actions.pending.createPr) ||
    (primary.kind === "merge" && actions.pending.merge) ||
    (primary.kind === "archive" && actions.pending.archive);

  const enabled = primaryEnabled(primary, view.w.state) && !pending;
  const Icon = ICONS[primary.kind];
  const shortcut = PRIMARY_SHORTCUT[primary.kind];

  const checksUrl =
    project && view.w.prNumber !== null
      ? githubChecksUrl(project.owner, project.name, view.w.prNumber)
      : undefined;

  const run = () => {
    switch (primary.kind) {
      case "commitPush":
        onCommitOpenChange(true);

        return;
      case "createPr":
        actions.createPr();

        return;
      case "viewChecks":
        actions.viewChecks(checksUrl);

        return;
      case "merge":
        actions.merge();

        return;
      case "archive":
        actions.archive();

        return;
    }
  };

  const button = (
    <Button
      size="sm"
      disabled={!enabled}
      onClick={primary.kind === "commitPush" ? undefined : run}
      className={cn("h-6", className)}
    >
      {pending ? <Spinner className="size-3" /> : <Icon />}
      {primary.label}
    </Button>
  );

  const withTooltip = (child: ReactElement) =>
    shortcut ? (
      <SimpleTooltip
        label={
          <span className="inline-flex items-center gap-1.5">
            {primary.label}{" "}
            <ShortcutKbd action={shortcut} className="border-background/30 bg-transparent text-background" />
          </span>
        }
      >
        {child}
      </SimpleTooltip>
    ) : (
      child
    );

  if (primary.kind !== "commitPush") return withTooltip(button);

  return (
    <Popover open={commitOpen && enabled} onOpenChange={onCommitOpenChange}>
      {withTooltip(<PopoverTrigger asChild>{button}</PopoverTrigger>)}
      <PopoverContent align="end" className="w-80">
        <CommitForm
          placeholder={view.w.title}
          onSubmit={(message) => {
            actions.commit(message);
            onCommitOpenChange(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

const SUBMIT = { code: "Enter", mod: true } as const;

/** The commit message: Enter or ⌘Enter commits, ⇧Enter adds a line. Empty uses the workspace title. */
function CommitForm({ placeholder, onSubmit }: { placeholder: string; onSubmit: (message: string) => void }) {
  const id = useId();
  const [message, setMessage] = useState("");

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    onSubmit(message.trim());
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <Label htmlFor={id}>Commit message</Label>
      <Textarea
        id={id}
        autoFocus
        rows={3}
        value={message}
        placeholder={placeholder}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.key !== "Enter") return;

          if (
            matchesCombo(e, SUBMIT, isMacPlatform()) ||
            (!e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey)
          ) {
            submit();
            e.preventDefault();
          }
        }}
        className="max-h-40"
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm">
          Commit and push
        </Button>
      </div>
    </form>
  );
}
