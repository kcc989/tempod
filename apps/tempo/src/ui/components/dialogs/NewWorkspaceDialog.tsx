import { useNavigate } from "@tanstack/react-router";
import type { Project } from "@tempo/protocol";
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
import { Popover, PopoverContent, PopoverTrigger } from "~/ui/components/ui/popover";
import { Label } from "~/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "~/ui/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/components/ui/tabs";
import { Textarea } from "~/ui/components/ui/textarea";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { useCredentialStatus } from "~/ui/hooks/useCredentialStatus";
import { useAgentChoices } from "~/ui/hooks/useAgentChoices";
import { useProjects } from "~/ui/hooks/useProjects";
import { useIsPhone } from "~/ui/hooks/useMediaQuery";
import { useDialog } from "~/ui/hooks/useWorkspaceUi";
import { agentLabel } from "~/ui/lib/agents";
import { cn } from "~/ui/lib/utils";
import { getHubStore } from "~/ui/stores/hub-store";
import { closeDialog, openDialog, setPhonePane, type DialogOf } from "~/ui/state/workspace-ui";
import { BranchPicker } from "./BranchPicker";
import {
  libraryAgentOf,
  agentsWithLogin,
  libraryAgentValue,
  libraryAgentsWithLogin,
  createInput,
  emptySource,
  filterPullRequests,
  initialAgent,
  initialModel,
  modelChoices,
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
          <DialogDescription className="sr-only">
            Choose a project and model, then describe what you want to work on.
          </DialogDescription>
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
  const models = useCallQuery("listModels", {}, { staleTime: 30_000, enabled: credentials.isSuccess });
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(args.prompt ?? "");
  const [keepOpen, setKeepOpen] = useState(false);
  const [tried, setTried] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const creating = useRef(false);

  const project = projects.find((p) => p.id === projectId) ?? projects[0]!;
  const libraryAgents = useAgentChoices(project.settings.agent?.default ?? "claude");
  const available = agentsWithLogin(credentials.data);
  const choices = modelChoices(available, models.data ?? []);

  const selected =
    choices.find((choice) => choice.key === pickedModel) ?? initialModel(choices, models.data ?? [], project);

  const custom = libraryAgentsWithLogin(libraryAgents.data, available);
  const pickedAgent = libraryAgentOf(pickedModel, custom);

  const repository = useCallQuery(
    "getRepository",
    { projectId: project.id },
    { enabled: project.provider === "artifacts" },
  );

  const writable = project.provider !== "artifacts" || (!!repository.data && !repository.data.readOnly);

  const requestedInput = pickedAgent
    ? createInput(project, source, pickedAgent.baseAgent, prompt, undefined, pickedAgent.id)
    : models.isSuccess && selected
      ? createInput(project, source, selected.agent, prompt, selected.model)
      : !prompt.trim()
        ? createInput(project, source, initialAgent(available, project), prompt)
        : null;

  const input = writable ? requestedInput : null;

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
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        document.getElementById("nw-prompt")?.focus();
      }}
    >
      <DialogHeader className="sr-only">
        <DialogTitle>New workspace</DialogTitle>
        <DialogDescription>
          Choose a project and model, then describe what you want to work on.
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex min-h-72 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {repository.data?.readOnly && (
          <p role="alert" className="px-4 py-3 text-sm text-muted-foreground">
            This repository is read-only.
          </p>
        )}
        {project.provider === "artifacts" && repository.isError && (
          <ErrorState error={repository.error} onRetry={() => void repository.refetch()} />
        )}
        <div className="flex items-center gap-2 border-b px-4 py-2 pr-12">
          <Select
            value={project.id}
            onValueChange={(value) => {
              setProjectId(value);
              setSource(emptySource());
            }}
          >
            <SelectTrigger
              id="nw-project"
              aria-label="Project"
              className="w-auto max-w-[70%] border-0 bg-transparent shadow-none"
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
              <Button type="button" variant="ghost" size="icon" aria-label="Workspace options">
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[min(24rem,calc(100vw-3rem))] space-y-3">
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
              <div className="flex items-center gap-2">
                <Checkbox
                  id="nw-keep"
                  checked={keepOpen}
                  onCheckedChange={(value) => setKeepOpen(value === true)}
                />
                <Label htmlFor="nw-keep" className="font-normal">
                  Keep open
                </Label>
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <Textarea
          id="nw-prompt"
          aria-label="Prompt"
          disabled={create.isPending}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="What do you want to work on?"
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing)
              return;
            event.preventDefault();
            submit();
          }}
          className="min-h-48 flex-1 max-h-[50dvh] resize-none rounded-none border-0 bg-transparent px-5 py-4 text-base shadow-none focus-visible:ring-1 focus-visible:ring-inset"
        />
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-4">
          <div className="min-w-0 flex-1">
            <Select
              value={pickedAgent ? libraryAgentValue(pickedAgent.id) : (selected?.key ?? "")}
              onValueChange={setPickedModel}
              disabled={!choices.length && !custom.length}
            >
              <SelectTrigger
                id="nw-model"
                aria-label="Model"
                className="w-auto max-w-full border-0 bg-transparent shadow-none"
              >
                <SelectValue
                  placeholder={
                    credentials.isPending || models.isPending ? "Loading models…" : "Choose a model"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {choices.map((choice) => (
                  <SelectItem key={choice.key} value={choice.key}>
                    {choice.name} <span className="text-muted-foreground">· {agentLabel(choice.agent)}</span>
                  </SelectItem>
                ))}
                {custom.length > 0 && <SelectSeparator />}
                {custom.map((a) => (
                  <SelectItem key={a.id} value={libraryAgentValue(a.id)}>
                    {a.name} <span className="text-muted-foreground">· {agentLabel(a.baseAgent)}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {credentials.isSuccess && !available.length && (
              <Button
                type="button"
                variant="link"
                className="h-auto px-3 text-xs"
                onClick={() => openDialog({ kind: "settings", tab: "logins" })}
              >
                Add a login to choose a model
              </Button>
            )}
            {models.isError && (
              <Button
                type="button"
                variant="link"
                className="h-auto px-3 text-xs"
                onClick={() => void models.refetch()}
              >
                Retry loading models
              </Button>
            )}
          </div>
          <Button
            type="submit"
            className="bg-foreground text-background hover:bg-foreground/90"
            disabled={create.isPending || !input}
          >
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
