import { useNavigate } from "@tanstack/react-router";
import type { AgentId, Project } from "@tempo/protocol";
import { CheckIcon, FolderGit2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { Checkbox } from "~/ui/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "~/ui/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/components/ui/dialog";
import { Label } from "~/ui/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/components/ui/tabs";
import { Textarea } from "~/ui/components/ui/textarea";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { useCredentialStatus } from "~/ui/hooks/useCredentialStatus";
import { useProjects } from "~/ui/hooks/useProjects";
import { useDialog } from "~/ui/hooks/useWorkspaceUi";
import { agentLabel } from "~/ui/lib/agents";
import { cn } from "~/ui/lib/utils";
import { getHubStore } from "~/ui/stores/hub-store";
import { closeDialog, openDialog, type DialogOf } from "~/ui/state/workspace-ui";
import { BranchPicker } from "./BranchPicker";
import {
  agentsWithLogin,
  createInput,
  emptySource,
  filterPullRequests,
  initialAgent,
  isSourceTab,
  SOURCE_TABS,
  type SourceDraft,
} from "./new-workspace-model";
import { Field, SubmitKbd } from "./parts";

/** 04, New workspace (⌥N). Args: the project and a prompt to start with. */
export function NewWorkspaceDialog() {
  const { open, args, onOpenChange } = useDialog("newWorkspace");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {args && <NewWorkspaceBody args={args} />}
    </Dialog>
  );
}

function NewWorkspaceBody({ args }: { args: DialogOf<"newWorkspace"> }) {
  const projects = useProjects();
  if (projects.isPending || projects.isError || projects.data.length === 0) {
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription className="sr-only">Pick a project, a branch and an agent.</DialogDescription>
        </DialogHeader>
        {projects.isPending ? (
          <SkeletonRows rows={4} />
        ) : projects.isError ? (
          <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
        ) : (
          <EmptyState
            icon={FolderGit2Icon}
            title="Link a repo to start."
            action={<Button onClick={() => openDialog({ kind: "addProject" })}>Add project</Button>}
          />
        )}
      </DialogContent>
    );
  }
  return <NewWorkspaceForm args={args} projects={projects.data} />;
}

function NewWorkspaceForm({
  args,
  projects,
}: {
  args: DialogOf<"newWorkspace">;
  projects: ReadonlyArray<Project>;
}) {
  const navigate = useNavigate();
  const credentials = useCredentialStatus();
  const [projectId, setProjectId] = useState(
    args.projectId && projects.some((p) => p.id === args.projectId) ? args.projectId : projects[0]!.id,
  );
  const [source, setSource] = useState<SourceDraft>(emptySource);
  const [pickedAgent, setPickedAgent] = useState<AgentId | null>(null);
  const [prompt, setPrompt] = useState(args.prompt ?? "");
  const [keepOpen, setKeepOpen] = useState(false);
  const [tried, setTried] = useState(false);

  const project = projects.find((p) => p.id === projectId) ?? projects[0]!;
  const available = agentsWithLogin(credentials.data);
  const agent = pickedAgent && available.includes(pickedAgent) ? pickedAgent : initialAgent(available, project);
  const input = createInput(project, source, agent, prompt);

  const create = useCallMutation("createWorkspace", {
    invalidates: ["listWorkspaces"],
    onSuccess: (summary) => {
      getHubStore().merge(summary);
      setTried(false);
      if (keepOpen) {
        setPrompt("");
        if (source.tab !== "new") setSource((s) => ({ ...s, branch: null, prNumber: null }));
        toast.success(`Created ${summary.title}`);
        return;
      }
      closeDialog("newWorkspace");
      void navigate({ to: "/w/$workspaceId", params: { workspaceId: summary.id } });
    },
  });

  const submit = () => {
    setTried(true);
    if (!input || create.isPending) return;
    create.mutate(input);
  };

  return (
    <DialogContent onSubmitShortcut={submit} className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>New workspace</DialogTitle>
        <DialogDescription className="sr-only">Pick a project, a branch and an agent.</DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Project" htmlFor="nw-project">
          <Select
            value={project.id}
            onValueChange={(v) => {
              setProjectId(v);
              setSource(emptySource());
            }}
          >
            <SelectTrigger id="nw-project" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.owner}/{p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Tabs
          value={source.tab}
          onValueChange={(v) => isSourceTab(v) && setSource((s) => ({ ...s, tab: v }))}
          className="gap-2"
        >
          <TabsList aria-label="Source" className="w-full">
            {SOURCE_TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="new">
            <Field label="Base branch" htmlFor="nw-base" hint="The new branch starts from this one.">
              <BranchPicker
                key={project.id}
                id="nw-base"
                projectId={project.id}
                label="Base branch"
                value={source.baseBranch || project.defaultBranch}
                placeholder={project.defaultBranch}
                onChange={(b) => setSource((s) => ({ ...s, baseBranch: b }))}
              />
            </Field>
          </TabsContent>
          <TabsContent value="branch">
            <Field
              label="Branch"
              htmlFor="nw-branch"
              error={tried && !source.branch ? "Pick a branch." : null}
            >
              <BranchPicker
                key={project.id}
                id="nw-branch"
                projectId={project.id}
                label="Branch"
                value={source.branch}
                placeholder="Pick a branch"
                invalid={tried && !source.branch}
                onChange={(b) => setSource((s) => ({ ...s, branch: b }))}
              />
            </Field>
          </TabsContent>
          <TabsContent value="pr">
            <PullRequestPicker
              key={project.id}
              projectId={project.id}
              value={source.prNumber}
              invalid={tried && source.prNumber === null}
              onChange={(n) => setSource((s) => ({ ...s, prNumber: n }))}
            />
          </TabsContent>
        </Tabs>

        <Field
          label="Agent"
          htmlFor="nw-agent"
          hint={
            available.length === 0 && credentials.isSuccess ? (
              <>
                No agent has a login yet.{" "}
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-xs"
                  onClick={() => openDialog({ kind: "settings", tab: "logins" })}
                >
                  Add a login
                </Button>
              </>
            ) : undefined
          }
        >
          <Select
            value={agent ?? ""}
            onValueChange={(v) => setPickedAgent(v as AgentId)}
            disabled={available.length === 0}
          >
            <SelectTrigger id="nw-agent" className="w-full">
              <SelectValue placeholder={credentials.isPending ? "Loading" : "No agent"} />
            </SelectTrigger>
            <SelectContent>
              {available.map((a) => (
                <SelectItem key={a} value={a}>
                  {agentLabel(a)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          label="Prompt"
          htmlFor="nw-prompt"
          hint="Attachments and @-mentions work once the workspace is open."
        >
          <Textarea
            id="nw-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the agent do?"
            className="max-h-60 min-h-20"
          />
        </Field>

        <DialogFooter className="sm:justify-between">
          <div className="flex items-center gap-2">
            <Checkbox id="nw-keep" checked={keepOpen} onCheckedChange={(c) => setKeepOpen(c === true)} />
            <Label htmlFor="nw-keep" className="font-normal">
              Keep open
            </Label>
          </div>
          <Button type="submit" disabled={create.isPending || (tried && !input)}>
            {create.isPending ? "Creating…" : "Create"}
            <SubmitKbd className="border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground" />
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function PullRequestPicker({
  projectId,
  value,
  invalid,
  onChange,
}: {
  projectId: string;
  value: number | null;
  invalid: boolean;
  onChange: (n: number) => void;
}) {
  const prs = useCallQuery("listOpenPullRequests", { projectId }, { staleTime: 30_000 });
  const [search, setSearch] = useState("");
  if (prs.isPending) return <SkeletonRows rows={3} />;
  if (prs.isError) return <ErrorState error={prs.error} onRetry={() => void prs.refetch()} />;
  const shown = filterPullRequests(prs.data, search);
  return (
    <div className="grid gap-1.5">
      <Command
        shouldFilter={false}
        label="Open pull requests"
        className={cn("rounded-md border", invalid && "border-destructive")}
      >
        <CommandInput value={search} onValueChange={setSearch} placeholder="Search pull requests" />
        <CommandList className="max-h-48">
          <CommandEmpty>{prs.data.length === 0 ? "No open pull requests." : "No matches."}</CommandEmpty>
          <CommandGroup>
            {shown.map((p) => (
              <CommandItem key={p.number} value={String(p.number)} onSelect={() => onChange(p.number)}>
                <CheckIcon aria-hidden className={cn("size-3", p.number === value ? "opacity-100" : "opacity-0")} />
                <span className="text-muted-foreground">#{p.number}</span>
                <span className="min-w-0 flex-1 truncate">{p.title}</span>
                <span className="max-w-32 truncate font-mono text-xs text-muted-foreground">{p.headBranch}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
      {invalid && (
        <p role="alert" className="text-xs text-destructive">
          Pick a pull request.
        </p>
      )}
    </div>
  );
}
