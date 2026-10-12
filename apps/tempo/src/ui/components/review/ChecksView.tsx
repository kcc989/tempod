import {
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleMinusIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { Spinner } from "~/ui/components/ui/spinner";
import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { useHubWorkspace } from "~/ui/hooks/useHub";
import { useProject } from "~/ui/hooks/useProjects";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { githubPullUrl } from "~/ui/lib/links";
import { cn } from "~/ui/lib/utils";
import {
  checksStateLabel,
  prStateLabel,
  runLabel,
  runOutcome,
  sortRuns,
  type RunOutcome,
} from "./checks-model";
import { safeHttpUrl } from "./browser-model";
import { ToneBadge } from "./parts";

const OUTCOME_ICON: Record<RunOutcome, { icon: typeof CheckCircle2Icon; className: string }> = {
  success: { icon: CheckCircle2Icon, className: "text-success" },
  failure: { icon: XCircleIcon, className: "text-destructive" },
  pending: { icon: CircleDashedIcon, className: "text-warning" },
  neutral: { icon: CircleMinusIcon, className: "text-muted-foreground" },
};

/** 04, Checks tab: the PR (number, title, state, GitHub link) and one row per check run. */
export function ChecksView({ workspaceId }: { workspaceId: string }) {
  const summary = useHubWorkspace(workspaceId);
  const detail = useWorkspaceSelector(workspaceId, (s) => s.workspace);
  const w = detail ?? summary;
  const project = useProject(w?.projectId);
  const prNumber = w?.prNumber ?? null;
  const prState = w?.prState ?? null;
  const checksState = w?.checksState ?? null;

  const runs = useCallQuery("listCheckRuns", { workspaceId }, { enabled: prNumber !== null, retry: false });
  const refresh = useCallMutation("refreshPullRequest", { toast: false });
  const { mutate } = refresh;
  const { refetch } = runs;

  useEffect(() => {
    if (prNumber !== null) mutate({ workspaceId });
  }, [prNumber, workspaceId, mutate]);

  const seen = useRef({ checksState, prState });
  useEffect(() => {
    if (seen.current.checksState === checksState && seen.current.prState === prState) return;
    seen.current = { checksState, prState };
    if (prNumber !== null) void refetch();
  }, [checksState, prState, prNumber, refetch]);

  const title = detail?.prTitle ?? refresh.data?.prTitle ?? null;
  const sorted = useMemo(() => sortRuns(runs.data ?? []), [runs.data]);

  if (!w) return <SkeletonRows />;
  if (prNumber === null) return <EmptyState title="No pull request yet." />;

  const pr = prStateLabel(prState);
  const checks = checksStateLabel(checksState);
  const url = project ? githubPullUrl(project.owner, project.name, prNumber) : null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-1.5 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-sm font-mono text-sm font-medium hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden"
            >
              #{prNumber}
              <ExternalLinkIcon aria-hidden className="size-3" />
              <span className="sr-only">Open on GitHub</span>
            </a>
          ) : (
            <span className="font-mono text-sm font-medium">#{prNumber}</span>
          )}
          {pr && <ToneBadge tone={pr.tone}>{pr.label}</ToneBadge>}
          {checks && <ToneBadge tone={checks.tone}>{checks.label}</ToneBadge>}
          <SimpleTooltip label="Refresh">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh"
              className="ml-auto"
              disabled={refresh.isPending}
              onClick={() => {
                refresh.mutate({ workspaceId });
                void refetch();
              }}
            >
              {refresh.isPending ? <Spinner /> : <RefreshCwIcon />}
            </Button>
          </SimpleTooltip>
        </div>
        {title && <p className="truncate text-sm">{title}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {runs.isPending ? (
          <SkeletonRows rows={4} />
        ) : runs.isError ? (
          <ErrorState error={runs.error} onRetry={() => void refetch()} />
        ) : sorted.length === 0 ? (
          <EmptyState title="No checks yet." />
        ) : (
          <ul aria-label="Check runs" className="flex flex-col p-1">
            {sorted.map((run, i) => {
              const outcome = runOutcome(run);
              const { icon: Icon, className } = OUTCOME_ICON[outcome];
              const href = safeHttpUrl(run.url);
              const content = (
                <>
                  <Icon aria-hidden className={cn("size-3.5 shrink-0", className)} />
                  <span className="min-w-0 flex-1 truncate">{run.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{runLabel(run)}</span>
                  {href && <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />}
                </>
              );
              return (
                <li key={`${run.name}:${i}`}>
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex h-7 items-center gap-2 rounded-sm px-2 text-sm hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden"
                    >
                      {content}
                    </a>
                  ) : (
                    <div className="flex h-7 items-center gap-2 px-2 text-sm">{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
