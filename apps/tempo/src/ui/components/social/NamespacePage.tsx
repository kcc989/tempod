import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { sessionQueryOptions } from "~/ui/auth";
import { NotFoundState } from "~/ui/components/shell/States";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { Label } from "~/ui/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "~/ui/components/ui/tabs";
import { useCallQuery } from "~/ui/hooks/useCall";
import { errorCode } from "~/ui/lib/toast";
import {
  canManage,
  cancelInvitation,
  fullOrganizationQueryOptions,
  inviteMember,
  removeMember,
  updateMemberRole,
  type FullOrganization,
  type OrganizationRole,
} from "~/ui/organizations";
import { CONFIRM_TEXT, confirm } from "~/ui/state/workspace-ui";
import { ProjectList } from "./ProjectList";

const showError = (error: Error) => toast.error(error.message);

/** 04, `/:namespace`: the namespace's projects and, for organization members, its members. */
export function NamespacePage({ namespace }: { namespace: string }) {
  const session = useQuery(sessionQueryOptions);
  const [offset, setOffset] = useState(0);
  const [tab, setTab] = useState<"projects" | "members">("projects");
  const projects = useCallQuery("listNamespaceProjects", { namespace, offset });

  const organization = useQuery({
    ...fullOrganizationQueryOptions(namespace.toLowerCase()),
    enabled: !!session.data,
  });

  const org = organization.data ?? null;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="flex flex-wrap items-center gap-3 border-b px-6 py-5">
        <h1 className="text-xl font-semibold">{org?.name ?? namespace}</h1>
        {org && <Badge variant="muted">Organization</Badge>}
      </header>
      <div className="flex flex-col gap-4 p-6">
        {org && (
          <Tabs value={tab} onValueChange={(value) => setTab(value === "members" ? "members" : "projects")}>
            <TabsList aria-label="Namespace sections">
              <TabsTrigger value="projects">Projects</TabsTrigger>
              <TabsTrigger value="members">Members</TabsTrigger>
            </TabsList>
          </Tabs>
        )}
        {org && tab === "members" ? (
          <OrganizationMembers organization={org} userId={session.data?.user.id ?? null} />
        ) : projects.isError && errorCode(projects.error) === "NOT_FOUND" ? (
          <NotFoundState />
        ) : (
          <ProjectList
            query={projects}
            label="Projects"
            empty="No projects here yet."
            offset={offset}
            onOffset={setOffset}
          />
        )}
      </div>
    </div>
  );
}

function OrganizationMembers({
  organization,
  userId,
}: {
  organization: FullOrganization;
  userId: string | null;
}) {
  const queryClient = useQueryClient();
  const mine = organization.members.find((m) => m.userId === userId);
  const manager = canManage(mine?.role);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["auth", "organization", organization.slug] });

  const invite = useMutation({
    mutationFn: () => inviteMember(organization.id, email.trim(), role),
    onSuccess: async () => {
      setEmail("");
      await refresh();
    },
    onError: showError,
  });

  const change = useMutation({
    mutationFn: (input: { memberId: string; role: OrganizationRole }) =>
      updateMemberRole(organization.id, input.memberId, input.role),
    onSuccess: refresh,
    onError: showError,
  });

  const remove = useMutation({
    mutationFn: (memberId: string) => removeMember(organization.id, memberId),
    onSuccess: refresh,
    onError: showError,
  });

  const cancel = useMutation({
    mutationFn: cancelInvitation,
    onSuccess: refresh,
    onError: showError,
  });

  return (
    <div className="flex flex-col gap-6">
      <ul className="divide-y rounded-lg border" aria-label="Members">
        {organization.members.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            {m.image ? (
              <img src={m.image} alt="" className="size-7 rounded-full" />
            ) : (
              <span className="size-7 rounded-full bg-muted" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{m.name}</p>
              <p className="truncate text-xs text-muted-foreground">{m.email}</p>
            </div>
            {manager && m.userId !== userId ? (
              <>
                <Select
                  value={m.role}
                  onValueChange={(value) =>
                    (value === "owner" || value === "admin" || value === "member") &&
                    change.mutate({ memberId: m.id, role: value })
                  }
                >
                  <SelectTrigger aria-label={`Role of ${m.name}`} className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="owner">Owner</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="member">Member</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={remove.isPending}
                  onClick={async () => {
                    if (await confirm(CONFIRM_TEXT.removeMember(m.name))) remove.mutate(m.id);
                  }}
                >
                  Remove
                </Button>
              </>
            ) : (
              <Badge variant="muted">{m.role}</Badge>
            )}
          </li>
        ))}
      </ul>
      {manager && (
        <>
          <form
            className="flex flex-wrap items-end gap-3 rounded-lg border p-4"
            onSubmit={(event) => {
              event.preventDefault();

              if (email.trim() && !invite.isPending) invite.mutate();
            }}
          >
            <div className="grid min-w-56 flex-1 gap-1.5">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="invite-role">Role</Label>
              <Select value={role} onValueChange={(value) => setRole(value === "admin" ? "admin" : "member")}>
                <SelectTrigger id="invite-role" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={!email.trim() || invite.isPending}>
              Invite
            </Button>
          </form>
          {organization.invitations.length > 0 && (
            <section aria-label="Pending invitations" className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold">Pending invitations</h2>
              <ul className="divide-y rounded-lg border">
                {organization.invitations.map((i) => (
                  <li key={i.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                    <span className="min-w-0 flex-1 truncate">{i.email}</span>
                    <Badge variant="muted">{i.role}</Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={cancel.isPending}
                      onClick={async () => {
                        if (await confirm(CONFIRM_TEXT.cancelInvitation(i.email))) cancel.mutate(i.id);
                      }}
                    >
                      Cancel
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
