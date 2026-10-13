import { useNavigate } from "@tanstack/react-router";
import type { AgentId, Project } from "@tempo/protocol";
import { CheckIcon, FolderGit2Icon, MoreHorizontalIcon, CornerDownLeftIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { Checkbox } from "~/ui/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/ui/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/ui/components/ui/dialog";
import { LaunchModelPicker } from "~/ui/components/chat/LaunchModelPicker";
import { Popover, PopoverContent, PopoverTrigger } from "~/ui/components/ui/popover";
import { Label } from "~/ui/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/components/ui/tabs";
import { Textarea } from "~/ui/components/ui/textarea";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { useCredentialStatus } from "~/ui/hooks/useCredentialStatus";
import { useProjects } from "~/ui/hooks/useProjects";
import { useIsPhone } from "~/ui/hooks/useMediaQuery";
import { useDialog } from "~/ui/hooks/useWorkspaceUi";
import { cn } from "~/ui/lib/utils";
import { getHubStore } from "~/ui/stores/hub-store";
import { closeDialog, openDialog, setPhonePane, type DialogOf } from "~/ui/state/workspace-ui";
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
import { Field } from "./parts";

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
  const isPhone = useIsPhone();
  const credentials = useCredentialStatus();
  const [projectId, setProjectId] = useState(
    args.projectId && projects.some((p) => p.id === args.projectId) ? args.projectId : projects[0]!.id,
  );
  const [source, setSource] = useState<SourceDraft>(emptySource);
  const [pickedAgent, setPickedAgent] = useState<AgentId | null>(null);
  const [prompt, setPrompt] = useState(args.prompt ?? "");
  const [model, setModel] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const creating = useRef(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [keepOpen, setKeepOpen] = useState(false);
  const [tried, setTried] = useState(false);

  const project = projects.find((p) => p.id === projectId) ?? projects[0]!;
  const available = agentsWithLogin(credentials.data);
  const agent =
    pickedAgent && available.includes(pickedAgent) ? pickedAgent : initialAgent(available, project);
  const selectedModel = pickedAgent === agent ? model : "";
  const input = createInput(project, source, agent, prompt, selectedModel);

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
      if (isPhone) setPhonePane("chat");
      void navigate({ to: "/w/$workspaceId", params: { workspaceId: summary.id } });
    },
  });

  const submit = () => {
    setTried(true);
    if (!input) {
      setOptionsOpen(true);
      return;
    }
    if (creating.current) return;
    creating.current = true;
    create.mutate(input, {
      onSettled: () => {
        creating.current = false;
      },
    });
  };

  return (
    <DialogContent
      onSubmitShortcut={submit}
      className="gap-0 overflow-visible rounded-2xl bg-muted p-0"
      style={{ width: "min(48rem, calc(100vw - 2rem))", maxWidth: "calc(100vw - 2rem)" }}
      overlayClassName="backdrop-blur-sm"
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        promptRef.current?.focus();
      }}
    >
      <DialogHeader className="sr-only">
        <DialogTitle>New workspace</DialogTitle>
        <DialogDescription>
          Pick a project and model, then describe what you want to work on. Enter creates an empty workspace
          too.
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex min-h-72 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex items-center gap-1 border-b px-3 py-2 pr-12">
          <Select
            value={project.id}
            onValueChange={(v) => {
              setProjectId(v);
              setSource(emptySource());
              setModel("");
            }}
          >
            <SelectTrigger
              aria-label="Project"
              id="nw-project"
              className="w-auto max-w-64 border-0 bg-transparent shadow-none"
            >
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

          <Popover open={optionsOpen} onOpenChange={setOptionsOpen}>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Workspace options">
                <MoreHorizontalIcon />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[min(28rem,calc(100vw-3rem))]">
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

              <div className="mt-3 flex items-center gap-2">
                <Checkbox id="nw-keep" checked={keepOpen} onCheckedChange={(c) => setKeepOpen(c === true)} />
                <Label htmlFor="nw-keep" className="font-normal">
                  Keep open
                </Label>
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <Textarea
          ref={promptRef}
          id="nw-prompt"
          aria-label="Prompt"
          disabled={create.isPending}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What do you want to work on?"
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.altKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (!input) setOptionsOpen(true);
            submit();
          }}
          className="max-h-[min(24rem,50dvh)] min-h-48 flex-1 resize-none rounded-none border-0 bg-transparent p-4 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex items-center justify-between gap-2 px-3 pb-3">
          <LaunchModelPicker
            agent={agent}
            model={selectedModel}
            disabled={create.isPending}
            defaultModel={
              project.settings.agent?.default === agent ? project.settings.agent?.model : undefined
            }
            onPick={(a, m) => {
              setPickedAgent(a);
              setModel(m);
            }}
            onClosed={() => promptRef.current?.focus()}
          />
          <Button type="submit" size="sm" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create"}
            <CornerDownLeftIcon className="size-3.5" />
          </Button>
        </div>
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
                <CheckIcon
                  aria-hidden
                  className={cn("size-3", p.number === value ? "opacity-100" : "opacity-0")}
                />
                <span className="text-muted-foreground">#{p.number}</span>
                <span className="min-w-0 flex-1 truncate">{p.title}</span>
                <span className="max-w-32 truncate font-mono text-xs text-muted-foreground">
                  {p.headBranch}
                </span>
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
