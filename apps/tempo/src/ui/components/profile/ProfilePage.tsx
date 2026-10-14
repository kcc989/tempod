import { FolderGit2Icon } from "lucide-react";
import { useState } from "react";
import { EmptyState, ErrorState, NotFoundState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { useCallQuery } from "~/ui/hooks/useCall";
import { errorCode } from "~/ui/lib/toast";
import { ProjectCard } from "./ProjectCard";

/** Pages hold at most 50 projects (11, Server functions). */
export const PAGE = 50;

/** 04, `/:username`: the owner's profile and public projects. */
export function ProfilePage({ username }: { username: string }) {
  const [offset, setOffset] = useState(0);
  const profile = useCallQuery("getProfile", { username });
  const projects = useCallQuery("listProfileProjects", offset ? { username, offset } : { username });

  if (profile.isPending) return <SkeletonRows rows={6} />;

  if (profile.isError)
    return errorCode(profile.error) === "NOT_FOUND" ? (
      <NotFoundState />
    ) : (
      <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />
    );
  const p = profile.data;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="flex items-center gap-4">
        {p.image ? (
          <img src={p.image} alt="" className="size-16 rounded-full border" />
        ) : (
          <div className="size-16 rounded-full border bg-muted" aria-hidden />
        )}
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">{p.name}</h1>
          <p className="text-sm text-muted-foreground">@{p.username}</p>
          {p.bio && <p className="mt-1 text-sm">{p.bio}</p>}
        </div>
      </header>
      <section className="flex flex-col gap-3" aria-labelledby="profile-repositories">
        <h2 id="profile-repositories" className="text-base font-semibold">
          Repositories
        </h2>
        {projects.isPending ? (
          <SkeletonRows rows={4} />
        ) : projects.isError ? (
          <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
        ) : projects.data.length === 0 ? (
          <EmptyState
            icon={FolderGit2Icon}
            title={offset > 0 ? "No more repositories." : "No public repositories yet."}
          />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2" aria-label="Repositories">
            {projects.data.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </ul>
        )}
        {(offset > 0 || projects.data?.length === PAGE) && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset((value) => Math.max(0, value - PAGE))}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={(projects.data?.length ?? 0) < PAGE}
              onClick={() => setOffset((value) => value + PAGE)}
            >
              Next
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
