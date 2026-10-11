import { ArrowRightIcon } from "lucide-react";
import { useHubWorkspace } from "~/ui/hooks/useHub";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { pillText } from "~/ui/lib/indicators";

export interface TopBarProps {
  readonly workspaceId: string;
  /** `phone`: a compact bar above the chat or changes pane. */
  readonly variant?: "desktop" | "phone";
}

/** REGION A placeholder: title, branch → base, container pill (04, Top bar). */
export function TopBar({ workspaceId }: TopBarProps) {
  const summary = useHubWorkspace(workspaceId);
  const detail = useWorkspaceSelector(workspaceId, (s) => s.workspace);
  const w = detail ?? summary;
  if (!w) return <header className="h-10 shrink-0 border-b" />;
  const pill = pillText(w.state, { op: detail?.op ?? null, instance: detail?.settings.environment.instance });
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
      <h1 className="truncate text-sm font-semibold">{w.title}</h1>
      <span className="flex min-w-0 items-center gap-1 truncate font-mono text-xs text-muted-foreground">
        {w.branch}
        <ArrowRightIcon className="size-3" />
        {w.baseBranch}
      </span>
      <span className="ml-auto rounded-md border px-2 py-0.5 text-xs text-muted-foreground">{pill.text}</span>
    </header>
  );
}
