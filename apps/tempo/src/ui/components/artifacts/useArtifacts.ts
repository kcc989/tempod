import type { Artifact } from "@tempo/protocol";
import { useEffect, useRef } from "react";
import { useCallQuery } from "~/ui/hooks/useCall";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";

/** Changes whenever an `artifact` item is added or changes status. */
const artifactItemsKey = (items: Readonly<Record<string, { kind: string; status: string }>>): string => {
  let key = "";
  for (const [id, item] of Object.entries(items))
    if (item.kind === "artifact") key += `${id}:${item.status};`;
  return key;
};

/**
 * Every artifact version of a workspace (listArtifacts), loaded again on every `item.upsert` of kind
 * `artifact` (04, Artifacts tab). It reads only the DO and R2, so it never wakes the workspace.
 */
export function useArtifacts(workspaceId: string): {
  readonly artifacts: ReadonlyArray<Artifact> | undefined;
  readonly error: Error | null;
  readonly refetch: () => void;
} {
  const key = useWorkspaceSelector(workspaceId, (s) => artifactItemsKey(s.items));
  const query = useCallQuery("listArtifacts", { workspaceId }, { staleTime: 60_000, retry: false });
  const { refetch } = query;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void refetch();
  }, [key, refetch]);
  return { artifacts: query.data, error: query.error, refetch: () => void refetch() };
}
