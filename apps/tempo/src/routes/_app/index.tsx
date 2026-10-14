import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RepositoryHub } from "~/ui/components/repositories/RepositoryHub";

export const Route = createFileRoute("/_app/")({ component: HomePage });

function HomePage() {
  const navigate = useNavigate();

  return (
    <RepositoryHub search={{}} onNavigate={(search) => void navigate({ to: "/repositories", search })} />
  );
}
