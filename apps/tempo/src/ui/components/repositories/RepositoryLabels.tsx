import type { RepositoryLabel } from "@tempo/protocol";
import { useState } from "react";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/ui/components/ui/dialog";
import { Input } from "~/ui/components/ui/input";
import { Label } from "~/ui/components/ui/label";
import { Checkbox } from "~/ui/components/ui/checkbox";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";

export function RepositoryLabelBadge({ label }: { label: RepositoryLabel }) {
  return (
    <Badge variant="outline" title={label.description}>
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: `#${label.color}` }}
      />
      {label.name}
    </Badge>
  );
}

export function RepositoryLabelSelector({
  labels,
  selected,
  onChange,
}: {
  labels: readonly RepositoryLabel[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  if (labels.length === 0)
    return <p className="text-xs text-muted-foreground">No labels yet. Add them from Manage labels.</p>;

  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-sm font-medium">Labels</legend>
      <div className="flex flex-wrap gap-3">
        {labels.map((label) => {
          const checked = selected.includes(label.id);

          return (
            <label key={label.id} className="flex items-center gap-2">
              <Checkbox
                aria-label={label.name}
                checked={checked}
                disabled={!checked && selected.length >= 25}
                onCheckedChange={(value) =>
                  onChange(
                    value === true ? [...selected, label.id] : selected.filter((id) => id !== label.id),
                  )
                }
              />
              <RepositoryLabelBadge label={label} />
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function RepositoryLabelManager({
  projectId,
  open,
  onOpenChange,
  onDeleted,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onDeleted?: (labelId: string) => void;
}) {
  const labels = useCallQuery("listRepositoryLabels", { projectId });
  const [editing, setEditing] = useState<RepositoryLabel | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState("64748b");
  const [description, setDescription] = useState("");

  const clear = () => {
    setEditing(null);
    setName("");
    setColor("64748b");
    setDescription("");
  };

  const options = {
    invalidates: ["listRepositoryLabels", "listRepositoryIssues", "getRepositoryIssue"] as const,
    onSuccess: clear,
  };

  const create = useCallMutation("createRepositoryLabel", options);
  const update = useCallMutation("updateRepositoryLabel", options);

  const remove = useCallMutation("deleteRepositoryLabel", {
    invalidates: ["listRepositoryLabels", "listRepositoryIssues", "getRepositoryIssue"],
    onSuccess: (_, input) => {
      if (editing?.id === input.labelId) clear();
      onDeleted?.(input.labelId);
    },
  });

  const pending = create.isPending || update.isPending || remove.isPending;

  const submit = () => {
    if (!name.trim() || pending) return;

    const input = { projectId, name: name.trim(), color, description };

    if (editing) update.mutate({ ...input, labelId: editing.id });
    else create.mutate(input);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" onSubmitShortcut={submit}>
        <DialogHeader>
          <DialogTitle>Manage labels</DialogTitle>
          <DialogDescription>
            Organize issues with labels. Deleting a label removes it from every issue.
          </DialogDescription>
        </DialogHeader>
        {labels.isPending ? (
          <SkeletonRows rows={4} />
        ) : labels.isError ? (
          <ErrorState error={labels.error} onRetry={() => void labels.refetch()} />
        ) : labels.data.length === 0 ? (
          <EmptyState title="No labels yet." />
        ) : (
          <ul className="flex max-h-64 flex-col gap-2 overflow-auto" aria-label="Repository labels">
            {labels.data.map((label) => (
              <li key={label.id} className="flex items-center justify-between gap-2 rounded-md border p-2">
                <div className="min-w-0">
                  <RepositoryLabelBadge label={label} />
                  {label.description && (
                    <p className="mt-1 truncate text-xs text-muted-foreground">{label.description}</p>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    aria-label={`Edit label ${label.name}`}
                    onClick={() => {
                      setEditing(label);
                      setName(label.name);
                      setColor(label.color);
                      setDescription(label.description);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    aria-label={`Delete label ${label.name}`}
                    onClick={() => remove.mutate({ projectId, labelId: label.id })}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form
          className="grid gap-3 border-t pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <p className="text-sm font-medium">{editing ? `Edit ${editing.name}` : "New label"}</p>
          <div className="flex items-end gap-3">
            <div className="grid min-w-0 flex-1 gap-1.5">
              <Label htmlFor="label-name">Name</Label>
              <Input
                id="label-name"
                value={name}
                maxLength={64}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="label-color">Color</Label>
              <input
                id="label-color"
                type="color"
                value={`#${color}`}
                onChange={(event) => setColor(event.target.value.slice(1).toLowerCase())}
                className="h-7 w-12 rounded border border-input bg-background outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="label-description">Description</Label>
            <Input
              id="label-description"
              value={description}
              maxLength={256}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={pending || !name.trim() || (!editing && (labels.data?.length ?? 0) >= 100)}
            >
              {pending ? "Saving…" : editing ? "Save label" : "Create label"}
            </Button>
            {editing && (
              <Button type="button" size="sm" variant="ghost" onClick={clear}>
                Cancel edit
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
