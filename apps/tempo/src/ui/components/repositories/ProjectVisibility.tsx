import type { Project, ProjectVisibility as Visibility } from "@tempo/protocol";
import { Link } from "@tanstack/react-router";
import { ExternalLinkIcon, PinIcon, PinOffIcon } from "lucide-react";
import { Button } from "~/ui/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/components/ui/select";
import { useCallMutation } from "~/ui/hooks/useCall";
import { CONFIRM_TEXT, confirm } from "~/ui/state/workspace-ui";

const isVisibility = (value: string): value is Visibility => value === "public" || value === "private";

/** 04, Public profile: the owner's visibility select, Pin and Public page in the repository header. */
export function ProjectVisibility({ project }: { project: Project }) {
  const visibility = project.visibility ?? "private";
  const setVisibility = useCallMutation("setProjectVisibility", { invalidates: ["listProjects"] });
  const setPinned = useCallMutation("setProjectPinned", { invalidates: ["listProjects"] });

  const change = async (value: string) => {
    if (!isVisibility(value) || value === visibility) return;

    if (value === "public" && !(await confirm(CONFIRM_TEXT.makePublic()))) return;
    setVisibility.mutate({ projectId: project.id, visibility: value });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={visibility}
        onValueChange={(value) => void change(value)}
        disabled={setVisibility.isPending}
      >
        <SelectTrigger aria-label="Visibility" size="sm" className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="private">Private</SelectItem>
          <SelectItem value="public">Public</SelectItem>
        </SelectContent>
      </Select>
      {visibility === "public" && (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={setPinned.isPending}
            onClick={() => setPinned.mutate({ projectId: project.id, pinned: !project.pinned })}
          >
            {project.pinned ? <PinOffIcon /> : <PinIcon />}
            {project.pinned ? "Unpin" : "Pin"}
          </Button>
          {project.username && project.slug && (
            <Button asChild size="sm" variant="outline">
              <Link to="/$username/$slug" params={{ username: project.username, slug: project.slug }}>
                Public page
                <ExternalLinkIcon />
              </Link>
            </Button>
          )}
        </>
      )}
    </div>
  );
}
