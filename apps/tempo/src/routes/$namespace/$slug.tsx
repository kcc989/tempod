import { createFileRoute } from "@tanstack/react-router";
import { repositorySearch } from "~/ui/components/repositories/model";
import { PublicFrame } from "~/ui/components/social/PublicFrame";
import { PublicProjectPage } from "~/ui/components/social/PublicProjectPage";

/** 04, `/:namespace/:slug`: the repository view; works without a session. */
export const Route = createFileRoute("/$namespace/$slug")({
  validateSearch: repositorySearch,
  component: ProjectRoute,
});

function ProjectRoute() {
  const { namespace, slug } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <PublicFrame>
      <PublicProjectPage
        key={`${namespace}/${slug}`}
        namespace={namespace}
        slug={slug}
        search={search}
        onNavigate={(next) => void navigate({ search: next })}
        onBack={() => void navigate({ to: "/$namespace", params: { namespace } })}
      />
    </PublicFrame>
  );
}
