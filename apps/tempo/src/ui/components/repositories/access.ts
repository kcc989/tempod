import { createContext, useContext } from "react";
import type { ProjectRole } from "@tempo/protocol";

/** What the viewer may do in a repository view (11, Function access; 04, Public projects). */
export interface RepositoryAccess {
  /** The membership role; null for a public visitor. */
  readonly role: ProjectRole | null;
  /** The signed-in user's id; null when anonymous. */
  readonly userId: string | null;
}

const RANK: Record<ProjectRole, number> = { read: 1, write: 2, admin: 3 };

const atLeast = (role: ProjectRole | null, need: ProjectRole): boolean =>
  role !== null && RANK[role] >= RANK[need];

/** A member's view: the signed-in sidebar projects all have `write` or higher. */
export const RepositoryAccessContext = createContext<RepositoryAccess>({ role: "admin", userId: null });

export const useRepositoryAccess = () => useContext(RepositoryAccessContext);

/** Members-only reads: CI runs and logs need a membership role, never a public grant. */
export const isMember = (a: RepositoryAccess): boolean => a.role !== null;

export const canWrite = (a: RepositoryAccess): boolean => atLeast(a.role, "write");

export const canAdmin = (a: RepositoryAccess): boolean => atLeast(a.role, "admin");

/** Comment edit and delete: the author with `write`, or an admin (11, policy `author`). */
export const canEditComment = (a: RepositoryAccess, authorId: string): boolean =>
  canAdmin(a) || (canWrite(a) && a.userId === authorId);
