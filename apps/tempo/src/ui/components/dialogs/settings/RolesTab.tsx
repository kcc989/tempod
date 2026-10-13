import { useState } from "react";
import type { RoleInfo } from "@tempo/protocol";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { Textarea } from "~/ui/components/ui/textarea";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { useOpenWorkspaceDetail } from "./useOpenWorkspace";

const NEW_ROLE =
  "---\ndescription: Describe the job\naccess: read-only\nrequestable: true\n---\nDescribe what the agent should do.\n";
export function RolesTab() {
  const workspace = useOpenWorkspaceDetail();
  const roles = useCallQuery("listRoles", workspace ? { workspaceId: workspace.id } : {});
  const [selected, setSelected] = useState<RoleInfo | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [text, setText] = useState(NEW_ROLE);
  const [loaded, setLoaded] = useState(false);
  const save = useCallMutation("putUserRole", {
    invalidates: ["listRoles", "getRoleText"],
    onSuccess: (role) => {
      setSelected(role);
      setAdding(false);
    },
  });
  const remove = useCallMutation("deleteUserRole", {
    invalidates: ["listRoles", "getRoleText"],
    onSuccess: () => {
      setSelected(null);
      setAdding(false);
    },
  });
  const reload = useCallMutation("reloadRoles", { invalidates: ["listRoles"] });
  const source = useCallQuery(
    "getRoleText",
    {
      name: selected?.name ?? "reviewer",
      scope: selected?.scope ?? "builtin",
      ...(workspace ? { workspaceId: workspace.id } : {}),
    },
    { enabled: !!selected },
  );
  if (selected && source.data && !loaded) {
    setText(source.data.text);
    setLoaded(true);
  }
  const edit = adding || selected?.scope === "user";
  const choose = (role: RoleInfo) => {
    setSelected(role);
    setName(role.name);
    setAdding(false);
    setLoaded(false);
  };
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Button
          onClick={() => {
            setSelected(null);
            setAdding(true);
            setName("");
            setText(NEW_ROLE);
            setLoaded(true);
          }}
        >
          Add role
        </Button>
        {workspace && (
          <Button
            variant="outline"
            disabled={reload.isPending}
            onClick={() => reload.mutate({ workspaceId: workspace.id })}
          >
            Reload repo roles
          </Button>
        )}
      </div>
      {save.isError && <ErrorState error={save.error} />}
      {remove.isError && <ErrorState error={remove.error} />}
      {reload.isError && <ErrorState error={reload.error} />}
      {roles.isPending ? (
        <SkeletonRows rows={4} />
      ) : roles.isError ? (
        <ErrorState error={roles.error} onRetry={() => void roles.refetch()} />
      ) : (
        <ul className="space-y-1">
          {roles.data?.map((r) => (
            <li key={`${r.scope}:${r.name}`}>
              <Button variant="ghost" onClick={() => choose(r)}>
                {r.name} · {r.scope}
              </Button>
              <span className="text-xs text-muted-foreground">
                {r.error ?? (r.shadowedBy ? `Shadowed by ${r.shadowedBy}` : r.description)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {(adding || selected) && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (edit) save.mutate({ name, text });
          }}
        >
          <label className="block">
            Name
            <Input
              value={name}
              disabled={!adding}
              onChange={(e) => setName(e.target.value)}
              pattern="[a-z][a-z0-9-]{1,31}"
              required
            />
          </label>
          <label className="block">
            Role file
            <Textarea
              value={text}
              readOnly={!edit}
              disabled={!!selected && !loaded}
              onChange={(e) => setText(e.target.value)}
              rows={18}
              className="font-mono text-xs"
            />
          </label>
          {source.isError && <ErrorState error={source.error} onRetry={() => void source.refetch()} />}
          {edit && (
            <div className="flex gap-2">
              <Button type="submit" disabled={save.isPending || !loaded}>
                Save
              </Button>
              {selected?.scope === "user" && (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm(`Delete role ${selected.name}?`))
                      remove.mutate({ name: selected.name });
                  }}
                >
                  Delete
                </Button>
              )}
            </div>
          )}
        </form>
      )}
    </div>
  );
}
