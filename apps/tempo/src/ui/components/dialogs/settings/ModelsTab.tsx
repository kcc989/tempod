import type { ModelPick } from "@tempo/protocol";
import { KeyRoundIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { Checkbox } from "~/ui/components/ui/checkbox";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { useCredentialStatus } from "~/ui/hooks/useCredentialStatus";
import { agentLabel } from "~/ui/lib/agents";
import { openDialog } from "~/ui/state/workspace-ui";
import { modelColumns, pickName, togglePick } from "../model-list-model";
import { agentsWithLogin } from "../new-workspace-model";

/** Settings → Models (04): the owner's model list (01, Model list). Each change saves at once. */
export function ModelsTab() {
  const credentials = useCredentialStatus();
  const available = agentsWithLogin(credentials.data);

  const models = useCallQuery(
    "listModels",
    {},
    { staleTime: 30_000, enabled: credentials.isSuccess && available.length > 0 },
  );

  const list = useCallQuery("getModelList", {});
  const [draft, setDraft] = useState<ModelPick[] | null>(null);

  const save = useCallMutation("setModelList", {
    invalidates: ["getModelList"],
    onError: () => setDraft(null),
  });

  if (credentials.isPending || list.isPending) return <SkeletonRows rows={4} />;

  if (credentials.isError)
    return <ErrorState error={credentials.error} onRetry={() => void credentials.refetch()} />;

  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;

  if (available.length === 0)
    return (
      <EmptyState
        icon={KeyRoundIcon}
        title="No agent has a login."
        action={
          <Button size="sm" onClick={() => openDialog({ kind: "settings", tab: "logins" })}>
            Connect another agent
          </Button>
        }
      />
    );

  const picks = draft ?? list.data.models;
  const reported = models.data ?? [];

  const change = (next: ModelPick[]) => {
    setDraft(next);
    save.mutate({ models: next });
  };

  return (
    <div className="grid gap-6">
      <p className="text-xs text-muted-foreground">
        Choose which models appear when you create a workspace or chat.
      </p>
      <section aria-labelledby="your-models" className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <h2 id="your-models" className="text-sm font-medium">
            Your models
          </h2>
          {picks.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => change([])}>
              Show all models
            </Button>
          )}
        </div>
        {picks.length === 0 ? (
          <p className="text-sm text-muted-foreground">All reported models are shown.</p>
        ) : (
          <ul aria-label="Your models" className="flex flex-wrap gap-2">
            {picks.map((pick) => {
              const name = pickName(pick, reported);

              return (
                <li
                  key={JSON.stringify([pick.agent, pick.model])}
                  className="flex items-center gap-1 rounded-md border py-1 pr-1 pl-3 text-sm"
                >
                  <span className="truncate">
                    {name} <span className="text-muted-foreground">· {agentLabel(pick.agent)}</span>
                  </span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${name}`}
                    onClick={() => change(togglePick(picks, pick))}
                  >
                    <XIcon aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {models.isPending ? (
        <SkeletonRows rows={4} />
      ) : models.isError ? (
        <ErrorState error={models.error} onRetry={() => void models.refetch()} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {modelColumns(available, reported, picks).map(({ agent, rows }) => (
            <section
              key={agent}
              aria-label={agentLabel(agent)}
              className="min-w-0 overflow-hidden rounded-lg border"
            >
              <h3 className="border-b bg-muted/40 px-3 py-2 text-sm font-medium">{agentLabel(agent)}</h3>
              <ul className="flex flex-col divide-y">
                {rows.map((row) => (
                  <li key={row.model}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                      <Checkbox
                        checked={row.picked}
                        onCheckedChange={() => change(togglePick(picks, { agent, model: row.model }))}
                      />
                      <span className="min-w-0 truncate" title={row.name}>
                        {row.reported ? (
                          row.name
                        ) : (
                          <>
                            {row.model} <span className="text-muted-foreground">· Not reported</span>
                          </>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
