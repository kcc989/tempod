import type { Project } from "@tempo/protocol";
import { useCallQuery } from "./useCall";

/** listProjects, in sort_order. */
export function useProjects() {
  return useCallQuery("listProjects", {}, { staleTime: 60_000, select: (ps) => [...ps].sort((a, b) => a.sortOrder - b.sortOrder) });
}

export function useProject(projectId: string | null | undefined): Project | undefined {
  const { data } = useProjects();
  return projectId ? data?.find((p) => p.id === projectId) : undefined;
}
