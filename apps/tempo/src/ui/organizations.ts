import { queryOptions } from "@tanstack/react-query";
import { authClient } from "./auth";

/** Organizations through the Better Auth plugin endpoints (11, Organizations; 04). */
export type OrganizationRole = "owner" | "admin" | "member";

export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface OrganizationMember {
  readonly id: string;
  readonly userId: string;
  readonly role: string;
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
}

export interface OrganizationInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly expiresAt: number;
}

export interface FullOrganization extends Organization {
  readonly members: ReadonlyArray<OrganizationMember>;
  readonly invitations: ReadonlyArray<OrganizationInvitation>;
}

export interface UserInvitation {
  readonly id: string;
  readonly organizationName: string;
  readonly role: string;
  readonly expiresAt: number;
}

/** A Better Auth refusal, with its code (for example `NAMESPACE_TAKEN`). */
export class OrganizationError extends Error {
  readonly code: string | null;

  constructor(message: string | undefined, code: string | undefined) {
    super(code === "NAMESPACE_TAKEN" ? "That name is already taken." : (message ?? "Something went wrong."));
    this.code = code ?? null;
  }
}

interface Failure {
  readonly message?: string | undefined;
  readonly code?: string | undefined;
}

const check = <T>(result: { data: T | null; error: Failure | null }): T => {
  if (result.error) throw new OrganizationError(result.error.message, result.error.code);

  if (result.data === null) throw new OrganizationError(undefined, undefined);

  return result.data;
};

const ms = (date: Date | string | number): number => new Date(date).getTime();

/** True when `role` (a comma list) holds owner or admin. */
export const canManage = (role: string | null | undefined): boolean =>
  !!role &&
  role
    .split(",")
    .map((r) => r.trim())
    .some((r) => r === "owner" || r === "admin");

/** The slug suggested for a name: lower case, other characters as `-`, at most 39 characters. */
export const slugFromName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39)
    .replace(/-+$/g, "");

export const organizationsQueryOptions = queryOptions({
  queryKey: ["auth", "organizations"] as const,
  queryFn: async (): Promise<Organization[]> =>
    check(await authClient().organization.list()).map((o) => ({ id: o.id, name: o.name, slug: o.slug })),
});

export const userInvitationsQueryOptions = queryOptions({
  queryKey: ["auth", "invitations"] as const,
  queryFn: async (): Promise<UserInvitation[]> =>
    check(await authClient().organization.listUserInvitations())
      .filter((i) => i.status === "pending")
      .map((i) => ({
        id: i.id,
        organizationName: i.organizationName,
        role: i.role,
        expiresAt: ms(i.expiresAt),
      })),
});

/** The organization with its members and invitations; null when the caller is not a member. */
export const fullOrganizationQueryOptions = (slug: string) =>
  queryOptions({
    queryKey: ["auth", "organization", slug] as const,
    queryFn: async (): Promise<FullOrganization | null> => {
      const { data, error } = await authClient().organization.getFullOrganization({
        query: { organizationSlug: slug },
      });

      if (error) {
        if (error.status === 400 || error.status === 403) return null;
        throw new OrganizationError(error.message, error.code);
      }

      if (!data) return null;

      return {
        id: data.id,
        name: data.name,
        slug: data.slug,
        members: data.members.map((m) => ({
          id: m.id,
          userId: m.userId,
          role: m.role,
          name: m.user.name,
          email: m.user.email,
          image: m.user.image ?? null,
        })),
        invitations: data.invitations
          .filter((i) => i.status === "pending")
          .map((i) => ({
            id: i.id,
            email: i.email,
            role: i.role,
            status: i.status,
            expiresAt: ms(i.expiresAt),
          })),
      };
    },
  });

export const createOrganization = async (name: string, slug: string): Promise<Organization> => {
  const o = check(await authClient().organization.create({ name, slug }));

  return { id: o.id, name: o.name, slug: o.slug };
};

export const inviteMember = async (
  organizationId: string,
  email: string,
  role: "member" | "admin",
): Promise<void> => {
  check(await authClient().organization.inviteMember({ organizationId, email, role }));
};

export const updateMemberRole = async (
  organizationId: string,
  memberId: string,
  role: OrganizationRole,
): Promise<void> => {
  check(await authClient().organization.updateMemberRole({ organizationId, memberId, role }));
};

export const removeMember = async (organizationId: string, memberIdOrEmail: string): Promise<void> => {
  check(await authClient().organization.removeMember({ organizationId, memberIdOrEmail }));
};

export const cancelInvitation = async (invitationId: string): Promise<void> => {
  check(await authClient().organization.cancelInvitation({ invitationId }));
};

export const acceptInvitation = async (invitationId: string): Promise<void> => {
  check(await authClient().organization.acceptInvitation({ invitationId }));
};

export const rejectInvitation = async (invitationId: string): Promise<void> => {
  check(await authClient().organization.rejectInvitation({ invitationId }));
};
