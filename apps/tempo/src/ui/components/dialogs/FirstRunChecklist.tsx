import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon, CircleIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useEffect } from "react";
import { Button } from "~/ui/components/ui/button";
import { ShortcutKbd } from "~/ui/components/ui/kbd";
import { setupStatusQueryOptions } from "~/ui/auth";
import { callKey } from "~/ui/hooks/useCall";
import { usePageVisible } from "~/ui/hooks/usePageActive";
import type { FirstRunStep, FirstRunStepId } from "~/ui/lib/first-run";
import { cn } from "~/ui/lib/utils";
import { openDialog } from "~/ui/state/workspace-ui";

export interface FirstRunChecklistProps {
  readonly steps: ReadonlyArray<FirstRunStep>;
  /** The GitHub App's install page, from /api/setup/status. */
  readonly installUrl: string | null;
}

/** Steps finished outside Tempo (on GitHub) are checked again this often while the page shows. */
const POLL_MS = 5_000;

const EXTERNAL: ReadonlySet<FirstRunStepId> = new Set(["createApp", "installApp"]);

/** 04, First-run setup: shown until every step is done. Each step's status is live. */
export function FirstRunChecklist({ steps, installUrl }: FirstRunChecklistProps) {
  const queryClient = useQueryClient();
  const visible = usePageVisible();
  const next = steps.find((s) => !s.done);
  const done = steps.filter((s) => s.done).length;

  const recheck = () => {
    void queryClient.invalidateQueries({ queryKey: setupStatusQueryOptions.queryKey });
    for (const name of [
      "listInstallations",
      "getCredentialStatus",
      "listProjects",
      "listWorkspaces",
    ] as const) {
      void queryClient.invalidateQueries({ queryKey: callKey(name) });
    }
  };

  const nextId = next?.id ?? null;
  useEffect(() => {
    if (!visible || nextId === null || !EXTERNAL.has(nextId)) return;
    const queryKey = nextId === "createApp" ? setupStatusQueryOptions.queryKey : callKey("listInstallations");
    const t = setInterval(() => void queryClient.invalidateQueries({ queryKey }), POLL_MS);
    return () => clearInterval(t);
  }, [visible, nextId, queryClient]);

  return (
    <section aria-labelledby="first-run-title" className="w-full max-w-md rounded-lg border p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 id="first-run-title" className="text-base font-semibold">
          Set up Tempo
        </h2>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {done} of {steps.length} done
        </span>
      </div>
      <ol className="flex flex-col gap-1">
        {steps.map((s, i) => {
          const current = s.id === next?.id;
          return (
            <li
              key={s.id}
              aria-current={current ? "step" : undefined}
              className={cn("flex flex-col gap-2 rounded-md px-2 py-1.5", current && "bg-muted/60")}
            >
              <div className="flex items-start gap-2 text-sm">
                {s.done ? (
                  <CheckCircle2Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                ) : (
                  <CircleIcon
                    aria-hidden
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      current ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                )}
                <span className={cn(s.done || !current ? "text-muted-foreground" : "font-medium")}>
                  <span className="sr-only">{s.done ? "Done: " : current ? "Next: " : "Not done: "}</span>
                  {i + 1}. {s.label}
                </span>
              </div>
              {current && (
                <div className="flex flex-wrap items-center gap-2 pl-6">
                  <StepAction id={s.id} installUrl={installUrl} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="ghost" onClick={recheck}>
          <RefreshCwIcon aria-hidden />
          Check again
        </Button>
      </div>
    </section>
  );
}

function StepAction({ id, installUrl }: { id: FirstRunStepId; installUrl: string | null }) {
  switch (id) {
    case "createApp":
      return (
        <p className="text-xs text-muted-foreground">
          Open the setup link that the deploy printed. It creates the GitHub App.
        </p>
      );
    case "installApp":
      return installUrl ? (
        <Button asChild size="sm">
          <a href={installUrl} target="_blank" rel="noopener noreferrer">
            Install the GitHub App
            <ExternalLinkIcon aria-hidden />
          </a>
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">Install the GitHub App from its page on GitHub.</p>
      );
    case "addLogin":
      return (
        <Button size="sm" onClick={() => openDialog({ kind: "settings", tab: "logins" })}>
          Add a login
        </Button>
      );
    case "linkRepo":
      return (
        <Button size="sm" onClick={() => openDialog({ kind: "addProject" })}>
          Add project
        </Button>
      );
    case "createWorkspace":
      return (
        <Button size="sm" onClick={() => openDialog({ kind: "newWorkspace" })}>
          New workspace
          <ShortcutKbd action="newWorkspace" className="bg-primary-foreground/15 text-primary-foreground" />
        </Button>
      );
  }
}
