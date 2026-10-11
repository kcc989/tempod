import type { WorkspaceSummary } from "@tempo/protocol";
import type { WorkspaceRow } from "../db/d1.ts";

export const summaryFromD1Row = (r: WorkspaceRow): WorkspaceSummary => ({
  id: r.id,
  projectId: r.projectId,
  slug: r.slug,
  title: r.title,
  branch: r.branch,
  baseBranch: r.baseBranch,
  state: r.state as WorkspaceSummary["state"],
  attention: r.attention as WorkspaceSummary["attention"],
  defaultAgent: r.defaultAgent as WorkspaceSummary["defaultAgent"],
  prNumber: r.prNumber,
  prState: r.prState as WorkspaceSummary["prState"],
  checksState: r.checksState as WorkspaceSummary["checksState"],
  pinned: r.pinned === 1,
  lastActivityAt: r.lastActivityAt,
  createdAt: r.createdAt,
  archivedAt: r.archivedAt,
  rev: r.summaryRev,
});
