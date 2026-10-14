import { createFileRoute } from "@tanstack/react-router";
import { Sidebar } from "~/ui/components/sidebar/Sidebar";

export const Route = createFileRoute("/_app/workspaces")({ component: WorkspacesPage });

function WorkspacesPage() {
  return <Sidebar variant="phone" />;
}
