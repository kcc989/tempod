import type { Project, ProjectRole } from "@tempo/protocol";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { sessionQueryOptions } from "~/ui/auth";
import { ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { Label } from "~/ui/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/components/ui/select";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { CONFIRM_TEXT, confirm } from "~/ui/state/workspace-ui";

const ROLES: ReadonlyArray<{ value: ProjectRole; label: string }> = [
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
  { value: "admin", label: "Admin" },
];

const isRole = (value: string): value is ProjectRole => ROLES.some((r) => r.value === value);

function RoleSelect({
  id,
  label,
  value,
  onChange,
}: {
  id?: string;
  label?: string;
  value: ProjectRole;
  onChange: (role: ProjectRole) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => isRole(next) && onChange(next)}>
      <SelectTrigger id={id} aria-label={label} className="w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ROLES.map((r) => (
          <SelectItem key={r.value} value={r.value}>
            {r.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 04, Settings → project → Access: visibility and members for admins; Leave project for others. */
export function ProjectAccess({ project }: { project: Project }) {
  if (project.role !== "admin" && project.role !== undefined) return <LeaveProject project={project} />;

  return (
    <div className="grid gap-6">
      <Visibility project={project} />
      <Members projectId={project.id} />
    </div>
  );
}

function Visibility({ project }: { project: Project }) {
  const set = useCallMutation("setProjectVisibility", {
    invalidates: ["listProjects", "getProject", "listNamespaceProjects", "exploreProjects"],
  });

  return (
    <section aria-labelledby="ps-visibility" className="grid gap-2">
      <h3 id="ps-visibility" className="text-sm font-semibold">
        Visibility
      </h3>
      <Select
        value={project.visibility ?? "private"}
        disabled={set.isPending}
        onValueChange={async (value) => {
          if (value !== "public" && value !== "private") return;

          if (value === "public" && !(await confirm(CONFIRM_TEXT.makePublic()))) return;
          set.mutate({ projectId: project.id, visibility: value });
        }}
      >
        <SelectTrigger aria-labelledby="ps-visibility" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="private">Private</SelectItem>
          <SelectItem value="public">Public</SelectItem>
        </SelectContent>
      </Select>
    </section>
  );
}

function Members({ projectId }: { projectId: string }) {
  const members = useCallQuery("listProjectMembers", { projectId });
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<ProjectRole>("write");

  const put = useCallMutation("putProjectMember", {
    invalidates: ["listProjectMembers"],
    onSuccess: () => setUsername(""),
  });

  const remove = useCallMutation("deleteProjectMember", { invalidates: ["listProjectMembers"] });

  return (
    <section aria-labelledby="ps-members" className="grid gap-3">
      <h3 id="ps-members" className="text-sm font-semibold">
        Members
      </h3>
      <p className="text-xs text-muted-foreground">
        Organization owners and admins have admin on every project of the organization; members can read.
      </p>
      {members.isPending ? (
        <SkeletonRows rows={3} />
      ) : members.isError ? (
        <ErrorState error={members.error} onRetry={() => void members.refetch()} />
      ) : members.data.length > 0 ? (
        <ul className="divide-y rounded-lg border" aria-label="Project members">
          {members.data.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {m.name}
                {m.username && <span className="ml-2 text-muted-foreground">{m.username}</span>}
              </span>
              <RoleSelect
                label={`Role of ${m.name}`}
                value={m.role}
                onChange={(next) => m.username && put.mutate({ projectId, username: m.username, role: next })}
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={remove.isPending}
                onClick={async () => {
                  if (await confirm(CONFIRM_TEXT.removeMember(m.name)))
                    remove.mutate({ projectId, userId: m.userId });
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();

          if (username.trim() && !put.isPending) put.mutate({ projectId, username: username.trim(), role });
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="ps-member-username">Username</Label>
          <Input
            id="ps-member-username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className="w-56"
            autoComplete="off"
          />
        </div>
        <RoleSelect label="Role" value={role} onChange={setRole} />
        <Button type="submit" size="sm" variant="outline" disabled={!username.trim() || put.isPending}>
          Add member
        </Button>
      </form>
    </section>
  );
}

function LeaveProject({ project }: { project: Project }) {
  const session = useQuery(sessionQueryOptions);

  const leave = useCallMutation("deleteProjectMember", {
    invalidates: ["listProjects", "listWorkspaces"],
  });

  const userId = session.data?.user.id;

  return (
    <section aria-labelledby="ps-leave" className="grid gap-2">
      <h3 id="ps-leave" className="text-sm font-semibold">
        Leave project
      </h3>
      <Button
        type="button"
        size="sm"
        variant="destructive"
        className="w-fit"
        disabled={!userId || leave.isPending}
        onClick={async () => {
          if (userId && (await confirm(CONFIRM_TEXT.leaveProject())))
            leave.mutate({ projectId: project.id, userId });
        }}
      >
        Leave project
      </Button>
    </section>
  );
}
