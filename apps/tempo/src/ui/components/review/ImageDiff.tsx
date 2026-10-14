import { imageDataUrl } from "~/ui/components/artifacts/artifact-model";
import { Skeleton } from "~/ui/components/ui/skeleton";
import { useCallQuery } from "~/ui/hooks/useCall";
import { errorText } from "~/ui/lib/toast";

/**
 * 04 Diff tab: an image file shows `Before` and `After` side by side (stacked below 1024 px).
 * Before is the file in `beforeSha` (readFileAt); After is the working tree (readFile). An added
 * file has no Before, a deleted one no After. SVG renders only through `<img>`.
 */
export function ImageDiff({
  workspaceId,
  path,
  oldPath,
  status,
  beforeSha,
  live,
}: {
  workspaceId: string;
  path: string;
  oldPath: string;
  status: string;
  beforeSha: string | null;
  live: boolean;
}) {
  const hasBefore = status !== "A" && beforeSha !== null;
  const hasAfter = status !== "D";

  const before = useCallQuery(
    "readFileAt",
    { workspaceId, path: oldPath, sha: beforeSha ?? "" },
    { enabled: live && hasBefore, retry: false, staleTime: 30_000 },
  );

  const after = useCallQuery(
    "readFile",
    { workspaceId, path },
    { enabled: live && hasAfter, retry: false, staleTime: 5_000 },
  );

  return (
    <div className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-2">
      {status !== "A" && <Side label="Before" path={oldPath} query={before} />}
      {hasAfter && <Side label="After" path={path} query={after} />}
    </div>
  );
}

function Side({
  label,
  path,
  query,
}: {
  label: string;
  path: string;
  query: {
    data?: { content: string; encoding: "utf8" | "base64" } | undefined;
    error: Error | null;
  };
}) {
  const src = query.data ? imageDataUrl(path, query.data) : null;

  return (
    <figure className="flex min-w-0 flex-col gap-1">
      <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
      {src ? (
        <img
          src={src}
          alt={`${label}: ${path}`}
          className="max-h-96 w-fit max-w-full rounded-sm border object-contain"
        />
      ) : query.error ? (
        <p className="text-sm text-muted-foreground">{errorText(query.error)}</p>
      ) : query.data ? (
        <p className="text-sm text-muted-foreground">Binary file.</p>
      ) : (
        <Skeleton className="h-32 w-48" />
      )}
    </figure>
  );
}
