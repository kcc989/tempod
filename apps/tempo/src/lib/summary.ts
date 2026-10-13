import type { WorkspaceSummary } from "@tempo/protocol";
import type { WorkspaceRow } from "../db/d1.ts";

export const summaryFromD1Row = (r: WorkspaceRow): WorkspaceSummary => ({
  id: r.id,
  projectId: r.projectId,
  slug: r.slug,
  title: r.title,
  branch: r.branch,
  baseBranch: r.baseBranch,
  state: r.state,
  attention: r.attention,
  defaultAgent: r.defaultAgent,
  prNumber: r.prNumber,
  prState: r.prState,
  checksState: r.checksState,
  pinned: r.pinned === 1,
  lastActivityAt: r.lastActivityAt,
  createdAt: r.createdAt,
  archivedAt: r.archivedAt,
  rev: r.summaryRev,
});
