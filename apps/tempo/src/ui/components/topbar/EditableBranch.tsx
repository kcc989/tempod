import { useState } from "react";
import { InlineEdit } from "./InlineEdit";
import type { WorkspaceView } from "./topbar-logic";

export function EditableBranch({ view, onSave }: { view: WorkspaceView; onSave: (branch: string) => void }) {
  const [editing, setEditing] = useState(false);
  const locked = !view.d || view.d.pushed || !["ready", "working", "sleeping"].includes(view.w.state);

  if (editing && !locked)
    return (
      <InlineEdit
        value={view.w.branch}
        label="Branch name"
        maxLength={250}
        onSave={onSave}
        onDone={() => setEditing(false)}
        className="w-56 font-mono"
      />
    );

  return (
    <button
      type="button"
      disabled={locked}
      onDoubleClick={() => setEditing(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setEditing(true);
        }
      }}
      aria-label="Rename branch"
      title={locked ? view.w.branch : "Double-click to rename branch"}
      className="min-w-0 truncate rounded px-1 hover:bg-accent disabled:hover:bg-transparent"
    >
      {view.w.branch}
    </button>
  );
}
