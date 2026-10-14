import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { BuildingIcon, ExternalLinkIcon, FolderGit2Icon, LockIcon, UserIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/components/ui/dialog";
import { Input } from "~/ui/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/components/ui/tabs";
import { RepositoryForm } from "~/ui/components/repositories/RepositoryForm";
import { setupStatusQueryOptions } from "~/ui/auth";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { useProjects } from "~/ui/hooks/useProjects";
import { useDialog } from "~/ui/hooks/useWorkspaceUi";
import { closeDialog } from "~/ui/state/workspace-ui";

/** 04, Add project: each GitHub App installation with its repos; Link calls linkProject. */
export function AddProjectDialog() {
  const { open, onOpenChange } = useDialog("addProject");

  const navigate = useNavigate();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add repository</DialogTitle>
          <DialogDescription>
            Host code on Cloudflare Artifacts or link a GitHub repository.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <Tabs defaultValue="artifacts" className="gap-4">
            <TabsList aria-label="Repository provider" className="w-full">
              <TabsTrigger value="artifacts">Cloudflare Artifacts</TabsTrigger>
              <TabsTrigger value="github">GitHub</TabsTrigger>
            </TabsList>
            <TabsContent value="artifacts">
              <RepositoryForm
                onSuccess={(project) => {
                  toast.success(`Added ${project.name}`);
                  closeDialog("addProject");
                  void navigate({ to: "/repositories", search: { project: project.id } });
                }}
              />
            </TabsContent>
            <TabsContent value="github">
              <Installations />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

function InstallLink({ installUrl, label }: { installUrl: string | null; label: string }) {
  if (!installUrl) return null;

  return (
    <Button asChild size="sm" variant="outline">
      <a href={installUrl} target="_blank" rel="noopener noreferrer">
        {label}
        <ExternalLinkIcon aria-hidden />
      </a>
    </Button>
  );
}

function Installations() {
  const installations = useCallQuery("listInstallations", {});
  const setup = useQuery(setupStatusQueryOptions);
  const [search, setSearch] = useState("");
  const installUrl = setup.data?.installUrl ?? null;

  if (installations.isPending) return <SkeletonRows rows={4} />;

  if (installations.isError) {
    return <ErrorState error={installations.error} onRetry={() => void installations.refetch()} />;
  }

  if (installations.data.length === 0) {
    return (
      <EmptyState
        icon={FolderGit2Icon}
        title="Install the GitHub App"
        description={
          installUrl
            ? "Install it on an account or org, then pick the repos it can reach."
            : "The install link shows here once the GitHub App exists."
        }
        action={<InstallLink installUrl={installUrl} label="Install the GitHub App" />}
      />
    );
  }

  return (
    <>
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search repos"
        aria-label="Search repos"
        autoFocus
      />
      <div className="-mx-1 flex max-h-[min(60dvh,28rem)] flex-col gap-3 overflow-y-auto px-1">
        {installations.data.map((i) => (
          <Repos
            key={i.installationId}
            installationId={i.installationId}
            account={i.accountLogin}
            organization={i.accountType === "Organization"}
            search={search}
          />
        ))}
      </div>
      <DialogFooter className="sm:justify-between">
        <p className="text-xs text-muted-foreground">Repo missing? Give the app access to it on GitHub.</p>
        <InstallLink installUrl={installUrl} label="Manage on GitHub" />
      </DialogFooter>
    </>
  );
}

function Repos({
  installationId,
  account,
  organization,
  search,
}: {
  installationId: number;
  account: string;
  organization: boolean;
  search: string;
}) {
  const repos = useCallQuery("listInstallationRepos", { installationId }, { staleTime: 60_000 });
  const projects = useProjects();

  const link = useCallMutation("linkProject", {
    invalidates: ["listProjects"],
    onSuccess: (p) => {
      toast.success(`Linked ${p.owner}/${p.name}`);
    },
  });

  const q = search.trim().toLowerCase();
  const shown = (repos.data ?? []).filter((r) => !q || `${r.owner}/${r.name}`.toLowerCase().includes(q));
  const linked = new Set((projects.data ?? []).map((p) => p.repoId));
  const AccountIcon = organization ? BuildingIcon : UserIcon;

  return (
    <section aria-label={account} className="flex flex-col gap-1">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <AccountIcon aria-hidden className="size-3" />
        {account}
      </h3>
      {repos.isPending && <SkeletonRows rows={3} />}
      {repos.isError && <ErrorState error={repos.error} onRetry={() => void repos.refetch()} />}
      {repos.isSuccess && shown.length === 0 && (
        <p className="px-1 py-1 text-sm text-muted-foreground">{q ? "No matching repos." : "No repos."}</p>
      )}
      <ul className="flex flex-col">
        {shown.map((r) => {
          const pending = link.isPending && link.variables?.repoId === r.repoId;

          return (
            <li
              key={r.repoId}
              className="flex items-center justify-between gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted/50"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">
                  {r.owner}/{r.name}
                </span>
                {r.private && (
                  <LockIcon aria-label="Private" className="size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate font-mono text-xs text-muted-foreground">{r.defaultBranch}</span>
              </span>
              {linked.has(r.repoId) ? (
                <Badge variant="muted">Linked</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={link.isPending}
                  aria-label={`Link ${r.owner}/${r.name}`}
                  onClick={() => link.mutate({ installationId, repoId: r.repoId })}
                >
                  {pending ? "Linking…" : "Link"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
