import { CheckCircle2Icon, CircleIcon } from "lucide-react";
import { Button } from "~/ui/components/ui/button";
import type { FirstRunStep } from "~/ui/lib/first-run";
import { openDialog } from "~/ui/state/workspace-ui";

export interface FirstRunChecklistProps {
  readonly steps: ReadonlyArray<FirstRunStep>;
  /** The GitHub App's install page, from /api/setup/status. */
  readonly installUrl: string | null;
}

/** REGION D placeholder: the first-run setup checklist (04, First-run setup). */
export function FirstRunChecklist({ steps, installUrl }: FirstRunChecklistProps) {
  const next = steps.find((s) => !s.done);
  return (
    <section aria-label="Set up Tempo" className="w-full max-w-md rounded-lg border p-4">
      <h2 className="mb-3 text-base font-semibold">Set up Tempo</h2>
      <ol className="flex flex-col gap-2">
        {steps.map((s) => (
          <li key={s.id} className="flex items-center gap-2 text-sm">
            {s.done ? (
              <CheckCircle2Icon aria-label="Done" className="size-4 text-success" />
            ) : (
              <CircleIcon aria-label="Not done" className="size-4 text-muted-foreground" />
            )}
            <span className={s.done ? "text-muted-foreground" : undefined}>{s.label}</span>
          </li>
        ))}
      </ol>
      <div className="mt-4">
        {next?.id === "installApp" && installUrl && (
          <Button asChild size="sm">
            <a href={installUrl} target="_blank" rel="noopener noreferrer">
              Install the GitHub App
            </a>
          </Button>
        )}
        {next?.id === "addLogin" && (
          <Button size="sm" onClick={() => openDialog({ kind: "settings", tab: "logins" })}>
            Add a login
          </Button>
        )}
        {next?.id === "linkRepo" && (
          <Button size="sm" onClick={() => openDialog({ kind: "addProject" })}>
            Add project
          </Button>
        )}
        {next?.id === "createWorkspace" && (
          <Button size="sm" onClick={() => openDialog({ kind: "newWorkspace" })}>
            New workspace
          </Button>
        )}
      </div>
    </section>
  );
}
