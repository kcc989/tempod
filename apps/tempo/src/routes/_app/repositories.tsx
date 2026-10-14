import { createFileRoute } from "@tanstack/react-router";
import { RepositoryHub } from "~/ui/components/repositories/RepositoryHub";
import { repositorySearch } from "~/ui/components/repositories/model";

export const Route = createFileRoute("/_app/repositories")({
  validateSearch: repositorySearch,
  component: RepositoriesPage,
});

function RepositoriesPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return <RepositoryHub search={search} onNavigate={(next) => void navigate({ search: next })} />;
}
