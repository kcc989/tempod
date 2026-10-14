import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { sessionQueryOptions } from "~/ui/auth";
import { RepositoryDetail } from "~/ui/components/repositories/RepositoryHub";
import type { RepositorySearch } from "~/ui/components/repositories/model";
import { ErrorState, NotFoundState, SkeletonRows } from "~/ui/components/shell/States";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import { useCallQuery } from "~/ui/hooks/useCall";
import { errorCode } from "~/ui/lib/toast";
import { StarButton } from "./StarButton";

/** 04, `/:namespace/:slug`: the repository view for anyone the project lets read it. */
export function PublicProjectPage({
  namespace,
  slug,
  search,
  onNavigate,
  onBack,
}: {
  namespace: string;
  slug: string;
  search: RepositorySearch;
  onNavigate: (search: RepositorySearch) => void;
  onBack: () => void;
}) {
  const session = useQuery(sessionQueryOptions);
  const project = useCallQuery("getProject", { namespace, slug });

  if (project.isPending) return <SkeletonRows rows={6} />;

  if (project.isError)
    return errorCode(project.error) === "NOT_FOUND" ? (
      <NotFoundState
        action={
          <Button asChild size="sm" variant="outline">
            <Link to="/explore">Explore</Link>
          </Button>
        }
      />
    ) : (
      <ErrorState error={project.error} onRetry={() => void project.refetch()} />
    );
  const p = project.data;
  const signedIn = !!session.data;

  return (
    <RepositoryDetail
      key={p.id}
      project={p}
      access={{ role: p.role, userId: session.data?.user.id ?? null }}
      title={`${p.namespace}/${p.slug}`}
      badges={
        <>
          <Badge variant="outline">{p.visibility === "private" ? "Private" : "Public"}</Badge>
          <StarButton projectId={p.id} initial={{ stars: p.stars, starred: p.starred }} signedIn={signedIn} />
        </>
      }
      search={{ ...search, project: p.id }}
      onNavigate={(next) => {
        const { project: _project, ...rest } = next;
        onNavigate(rest);
      }}
      onBack={onBack}
      backLabel={p.namespace}
    />
  );
}
