import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { Project } from "@tempo/protocol";
import { FolderGit2Icon } from "lucide-react";
import { useState } from "react";
import { setupStatusQueryOptions } from "~/ui/auth";
import { FirstRunChecklist } from "~/ui/components/dialogs/FirstRunChecklist";
import { CenteredLoading, EmptyState, ErrorState } from "~/ui/components/shell/States";
import { Sidebar } from "~/ui/components/sidebar/Sidebar";
import { Button } from "~/ui/components/ui/button";
import { ShortcutKbd } from "~/ui/components/ui/kbd";
import { Textarea } from "~/ui/components/ui/textarea";
import { useCallQuery } from "~/ui/hooks/useCall";
import { useCredentialStatus } from "~/ui/hooks/useCredentialStatus";
import { useHub } from "~/ui/hooks/useHub";
import { useIsPhone } from "~/ui/hooks/useMediaQuery";
import { useProjects } from "~/ui/hooks/useProjects";
import { firstRunSteps, isFirstRunDone } from "~/ui/lib/first-run";
import { isListed } from "~/ui/stores/hub-state";
import { openDialog } from "~/ui/state/workspace-ui";

export const Route = createFileRoute("/_app/")({
  component: HomePage,
});

function HomePage() {
  const isPhone = useIsPhone();

  if (!isPhone) return <Home />;

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <Home compact />
      <div className="min-h-0 flex-1">
        <Sidebar variant="phone" />
      </div>
    </div>
  );
}

/** 04, Empty states: first run, no projects, projects with no workspaces. */
function Home({ compact = false }: { compact?: boolean }) {
  const setup = useQuery(setupStatusQueryOptions);
  const installations = useCallQuery("listInstallations", {});
  const credentials = useCredentialStatus();
  const projects = useProjects();
  const all = useCallQuery("listWorkspaces", { includeArchived: true });
  const hub = useHub();
  const queries = [setup, installations, credentials, projects, all] as const;

  const failed = queries.find((q) => q.isError);

  if (failed) {
    return (
      <ErrorState
        className={compact ? undefined : "h-full"}
        error={failed.error}
        onRetry={() => queries.forEach((q) => void q.refetch())}
      />
    );
  }

  if (queries.some((q) => q.isPending) || !hub.ready) {
    return compact ? null : <CenteredLoading label="Loading" />;
  }

  const listed = Object.values(hub.workspaces).filter(isListed);

  const steps = firstRunSteps({
    configured: setup.data?.configured ?? true,
    installationCount: installations.data?.length ?? 0,
    credentials: credentials.data,
    projectCount: projects.data?.length ?? 0,
    workspaceCount: Math.max(all.data?.length ?? 0, listed.length),
  });

  if (!isFirstRunDone(steps)) {
    return (
      <div className="flex h-full items-start justify-center overflow-y-auto p-6 sm:items-center">
        <FirstRunChecklist steps={steps} installUrl={setup.data?.installUrl ?? null} />
      </div>
    );
  }

  if (compact) return null;

  if ((projects.data ?? []).length === 0) {
    return (
      <EmptyState
        className="h-full"
        icon={FolderGit2Icon}
        title="Link a repo to start."
        action={<Button onClick={() => openDialog({ kind: "addProject" })}>Add project</Button>}
      />
    );
  }

  const empty = (projects.data ?? []).filter((p) => !listed.some((w) => w.projectId === p.id));

  if (empty.length === 0) {
    return (
      <EmptyState
        className="h-full"
        title="Pick a workspace."
        description={
          <span className="inline-flex items-center gap-1">
            Or start a new one with <ShortcutKbd action="newWorkspace" />
          </span>
        }
      />
    );
  }

  return (
    <div className="flex h-full flex-col items-center gap-4 overflow-y-auto p-6 sm:justify-center">
      {empty.map((p) => (
        <StartWorkspace key={p.id} project={p} />
      ))}
    </div>
  );
}

/** 04: a project with no workspaces shows `Start a workspace` with a prompt box that opens New workspace. */
function StartWorkspace({ project }: { project: Project }) {
  const [prompt, setPrompt] = useState("");

  const start = () =>
    openDialog(
      prompt.trim()
        ? { kind: "newWorkspace", projectId: project.id, prompt }
        : { kind: "newWorkspace", projectId: project.id },
    );

  return (
    <form
      className="flex w-full max-w-lg flex-col gap-2 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        start();
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Start a workspace</h2>
        <span className="truncate text-xs text-muted-foreground">
          {project.owner}/{project.name}
        </span>
      </div>
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        aria-label={`Prompt for ${project.owner}/${project.name}`}
        placeholder="What should the agent do?"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            start();
          }
        }}
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm">
          Start
        </Button>
      </div>
    </form>
  );
}
