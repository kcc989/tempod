import { useQuery } from "@tanstack/react-query";
import { PR_GUIDE_PATH, type Project, type RepositoryPullRequest } from "@tempo/protocol";
import { BookOpenIcon } from "lucide-react";
import { Button } from "~/ui/components/ui/button";
import { decodeGuideFile, GuideChapters } from "~/ui/components/review/GuideChapters";
import { useApiCall } from "~/ui/hooks/useCall";
import { errorCode, errorText } from "~/ui/lib/toast";
import type { RepositoryHubProps } from "./RepositoryHub";
import { pullRequestGuideRefs, repositoryFileSearch } from "./model";

export function PullRequestGuide({
  project,
  pull,
  onNavigate,
}: {
  project: Project;
  pull: RepositoryPullRequest;
  onNavigate: RepositoryHubProps["onNavigate"];
}) {
  const invoke = useApiCall();
  const refs = pullRequestGuideRefs(pull);

  const file = useQuery({
    queryKey: ["repositoryPullRequestGuide", project.id, ...refs],
    queryFn: async () => {
      for (const ref of refs) {
        try {
          return {
            ref,
            file: await invoke("getRepositoryFile", { projectId: project.id, ref, path: PR_GUIDE_PATH }),
          };
        } catch (cause) {
          if (errorCode(cause) !== "NOT_FOUND") throw cause;
        }
      }

      return null;
    },
    retry: false,
  });

  if (file.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading guide…
      </p>
    );

  if (file.isError)
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
        <span>Could not load the guide: {errorText(file.error)}</span>
        <Button size="sm" variant="outline" onClick={() => void file.refetch()}>
          Retry
        </Button>
      </div>
    );

  if (!file.data) return <p className="text-sm text-muted-foreground">No guide for this pull request.</p>;
  const { ref } = file.data;
  const result = decodeGuideFile(file.data.file);

  if ("error" in result)
    return (
      <p role="alert" className="text-sm">
        This pull request’s guide is not valid.
      </p>
    );

  const openFile = (path: string) => onNavigate(repositoryFileSearch(project.id, ref, path));

  return (
    <section aria-label="Guide" className="overflow-hidden rounded-lg border">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <BookOpenIcon className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Guide</span>
      </div>
      <p className="border-b px-3 py-2 text-xs text-muted-foreground">
        Agent-authored explanation from {ref}. Open the pull request in a workspace to review its diff.
      </p>
      <GuideChapters
        className="md:h-[36rem]"
        guide={result.guide}
        source={{ kind: "repository", projectId: project.id, ref, openFile }}
        code={(chapter) =>
          chapter.files.length > 0 && (
            <div className="space-y-1">
              <h4 className="text-sm font-medium">Files</h4>
              <ul className="space-y-1 text-xs">
                {chapter.files.map((path) => (
                  <li key={path}>
                    <button
                      type="button"
                      className="break-all text-left text-primary underline focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => openFile(path)}
                    >
                      {path}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )
        }
      />
    </section>
  );
}
