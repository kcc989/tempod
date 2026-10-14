import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { sessionQueryOptions } from "~/ui/auth";
import { repositorySearch } from "~/ui/components/repositories/model";
import { PublicFrame } from "~/ui/components/profile/PublicFrame";
import { PublicProjectPage } from "~/ui/components/profile/PublicProjectPage";

/** 04, `/:username/:slug`: a public project's code; works without a session (11). */
export const Route = createFileRoute("/$username/$slug")({
  validateSearch: repositorySearch,
  component: PublicProjectRoute,
});

function PublicProjectRoute() {
  const { username, slug } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const session = useQuery(sessionQueryOptions);

  return (
    <PublicFrame username={username}>
      <PublicProjectPage
        key={`${username}/${slug}`}
        username={username}
        slug={slug}
        search={search}
        onNavigate={(next) => void navigate({ search: next })}
        owner={!!session.data}
      />
    </PublicFrame>
  );
}
