import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceLayout } from "~/ui/components/shell/WorkspaceLayout";

export const Route = createFileRoute("/_app/w/$workspaceId")({
  component: WorkspacePage,
});

function WorkspacePage() {
  const { workspaceId } = Route.useParams();
  return <WorkspaceLayout key={workspaceId} workspaceId={workspaceId} />;
}
