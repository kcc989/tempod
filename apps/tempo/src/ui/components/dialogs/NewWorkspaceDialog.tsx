import { useNavigate } from "@tanstack/react-router";
import type { Project } from "@tempo/protocol";
import { useState } from "react";
import { Button } from "~/ui/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/ui/components/ui/dialog";
import { Label } from "~/ui/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/components/ui/select";
import { Textarea } from "~/ui/components/ui/textarea";
import { useCallMutation } from "~/ui/hooks/useCall";
import { useProjects } from "~/ui/hooks/useProjects";
import { useDialog } from "~/ui/hooks/useWorkspaceUi";
import { getHubStore } from "~/ui/stores/hub-store";
import { closeDialog, type DialogOf } from "~/ui/state/workspace-ui";

/** REGION D placeholder: New workspace (⌥N). Args: projectId and prompt to prefill. */
export function NewWorkspaceDialog() {
  const { open, args, onOpenChange } = useDialog("newWorkspace");
  const projects = useProjects();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {args && projects.data && <NewWorkspaceForm args={args} projects={projects.data} />}
    </Dialog>
  );
}

function NewWorkspaceForm({
  args,
  projects,
}: {
  args: DialogOf<"newWorkspace">;
  projects: ReadonlyArray<Project>;
}) {
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState(args.projectId ?? projects[0]?.id ?? "");
  const [prompt, setPrompt] = useState(args.prompt ?? "");
  const create = useCallMutation("createWorkspace", {
    invalidates: ["listWorkspaces"],
    onSuccess: (summary) => {
      getHubStore().merge(summary);
      closeDialog("newWorkspace");
      void navigate({ to: "/w/$workspaceId", params: { workspaceId: summary.id } });
    },
  });
  const project = projects.find((p) => p.id === projectId);
  const submit = () => {
    if (!project || create.isPending) return;
    create.mutate({
      projectId: project.id,
      source: { kind: "new", baseBranch: project.defaultBranch },
      ...(prompt.trim() ? { prompt: { text: prompt.trim() } } : {}),
    });
  };

  return (
    <DialogContent onSubmitShortcut={submit} aria-describedby={undefined}>
      <DialogHeader>
        <DialogTitle>New workspace</DialogTitle>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor="nw-project">Project</Label>
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger id="nw-project" className="w-full">
            <SelectValue placeholder="Pick a project" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.owner}/{p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="nw-prompt">Prompt</Label>
        <Textarea
          id="nw-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should the agent do?"
        />
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={!project || create.isPending}>
          Create
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
