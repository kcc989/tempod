import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceLayout } from "~/ui/components/shell/WorkspaceLayout";
import { useEffect } from "react";
import { openGuide, setPhonePane } from "~/ui/state/workspace-ui";

export const Route = createFileRoute("/_app/w/$workspaceId")({
  validateSearch: (search: Record<string, unknown>): { guide?: boolean } =>
    search.guide === true || search.guide === "true" ? { guide: true } : {},
  component: WorkspacePage,
});

function WorkspacePage() {
  const { workspaceId } = Route.useParams();
  const { guide } = Route.useSearch();
  useEffect(() => {
    if (guide) {
      openGuide(workspaceId);
      setPhonePane("chat");
    }
  }, [guide, workspaceId]);
  return <WorkspaceLayout key={workspaceId} workspaceId={workspaceId} />;
}
