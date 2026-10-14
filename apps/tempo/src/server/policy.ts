import type { FnName } from "@tempo/protocol";

/** Functions that also run without a session, for public projects only (11, Function access). */
export const VISITOR_FNS = [
  "getProfile",
  "listProfileProjects",
  "getPublicProject",
  "getRepository",
  "getRepositoryFile",
  "listRepositoryCommits",
  "listBranches",
] as const satisfies ReadonlyArray<FnName>;

export type VisitorFnName = (typeof VISITOR_FNS)[number];

export const isVisitorFn = (name: FnName): name is VisitorFnName => VISITOR_FNS.some((n) => n === name);
