import { useState } from "react";
import { Schema } from "effect";
import {
  AttachmentOptions,
  HOOK_EVENTS,
  HookEvent,
  type AgentAttachment,
  type AttachmentHook,
} from "@tempo/protocol";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { useAgents } from "~/ui/hooks/useAgents";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { Textarea } from "~/ui/components/ui/textarea";
import { ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Field } from "~/ui/components/dialogs/parts";

export function ProjectAgentAttachments({ projectId }: { projectId: string }) {
  const library = useAgents();
  const attached = useCallQuery("listProjectAgents", { projectId });
  const [selected, setSelected] = useState("");
  const put = useCallMutation("putProjectAgent", { invalidates: ["listProjectAgents"] });

  if (attached.isPending || library.isPending) return <SkeletonRows rows={3} />;

  if (attached.isError) return <ErrorState error={attached.error} onRetry={() => void attached.refetch()} />;

  if (library.isError) return <ErrorState error={library.error} onRetry={() => void library.refetch()} />;
  const available = library.data.filter((a) => !attached.data.some((r) => r.agentId === a.id));

  return (
    <section className="grid gap-4" aria-label="Attached agents">
      <h3 className="text-sm font-medium">Attached agents</h3>
      <div className="flex flex-wrap gap-2">
        <label className="text-sm">
          Add agent from library{" "}
          <select
            aria-label="Add agent from library"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Choose an agent</option>
            {available.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · @{a.handle}
              </option>
            ))}
          </select>
        </label>
        <Button
          disabled={!selected || put.isPending}
          onClick={() =>
            put.mutate({
              projectId,
              agentId: selected,
              enabled: true,
              hooks: [],
              autoSend: false,
              maxRuns: 3,
              timeout: "20m",
            })
          }
        >
          Attach
        </Button>
      </div>
      {put.error && <ErrorState error={put.error} />}
      {attached.data.map((row) => (
        <AttachmentEditor key={row.id + ":" + row.updatedAt} attachment={row} />
      ))}
    </section>
  );
}

function AttachmentEditor({ attachment: a }: { attachment: AgentAttachment }) {
  const [draft, setDraft] = useState({
    enabled: a.enabled,
    hooks: [...a.hooks],
    autoSend: a.autoSend,
    maxRuns: a.maxRuns,
    timeout: a.timeout,
  });

  const put = useCallMutation("putProjectAgent", { invalidates: ["listProjectAgents"] });
  const remove = useCallMutation("deleteProjectAgent", { invalidates: ["listProjectAgents"] });

  const setHook = (i: number, patch: Partial<AttachmentHook>) =>
    setDraft((d) => ({ ...d, hooks: d.hooks.map((h, n) => (n === i ? { ...h, ...patch } : h)) }));

  const valid = Schema.is(AttachmentOptions)(draft);

  return (
    <div className="grid gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">
          {a.agent ? `${a.agent.name} · @${a.agent.handle}` : "This agent was deleted."}
        </h4>
        <Button
          variant="ghost"
          disabled={remove.isPending}
          onClick={() => remove.mutate({ projectId: a.projectId, agentId: a.agentId })}
        >
          Remove
        </Button>
      </div>
      {a.agent && (
        <>
          <label className="text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />{" "}
            Enabled
          </label>
          {draft.hooks.map((h, i) => (
            <fieldset key={i} className="grid gap-2 rounded border p-2">
              <legend className="text-sm">Hook {i + 1}</legend>
              <label className="text-sm">
                Event{" "}
                <select
                  aria-label={`Hook ${i + 1} event`}
                  value={h.event}
                  onChange={(e) => {
                    if (Schema.is(HookEvent)(e.target.value)) setHook(i, { event: e.target.value });
                  }}
                >
                  {HOOK_EVENTS.map((event) => (
                    <option key={event} value={event}>
                      {event}
                    </option>
                  ))}
                </select>
              </label>
              <Field label="Question" hint="Leave empty to always run for this event.">
                <Textarea
                  aria-label={`Hook ${i + 1} question`}
                  maxLength={500}
                  value={h.when ?? ""}
                  onChange={(e) => setHook(i, { when: e.target.value || null })}
                />
              </Field>
              <Field label="Threshold">
                <Input
                  aria-label={`Hook ${i + 1} threshold`}
                  type="number"
                  min={0.05}
                  max={0.95}
                  step={0.05}
                  value={h.threshold}
                  onChange={(e) => setHook(i, { threshold: Number(e.target.value) })}
                />
              </Field>
              <Button
                variant="ghost"
                onClick={() => setDraft({ ...draft, hooks: draft.hooks.filter((_, n) => n !== i) })}
              >
                Remove hook
              </Button>
            </fieldset>
          ))}
          <Button
            variant="outline"
            disabled={draft.hooks.length >= 8}
            onClick={() =>
              setDraft({
                ...draft,
                hooks: [...draft.hooks, { event: "branch.pushed", when: null, threshold: 0.5 }],
              })
            }
          >
            Add hook
          </Button>
          <label className="text-sm">
            <input
              type="checkbox"
              checked={draft.autoSend}
              onChange={(e) => setDraft({ ...draft, autoSend: e.target.checked })}
            />{" "}
            Automatically send result to chat
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Max runs per change">
              <Input
                aria-label="Max runs per change"
                type="number"
                min={1}
                max={10}
                value={draft.maxRuns}
                onChange={(e) => setDraft({ ...draft, maxRuns: Number(e.target.value) })}
              />
            </Field>
            <Field label="Timeout" hint="Minutes or hours, at most 2h.">
              <Input
                aria-label="Timeout"
                value={draft.timeout}
                onChange={(e) => setDraft({ ...draft, timeout: e.target.value })}
              />
            </Field>
          </div>
          <Button
            disabled={!valid || put.isPending}
            onClick={() => put.mutate({ projectId: a.projectId, agentId: a.agentId, ...draft })}
          >
            Save attachment
          </Button>
          {put.error && <ErrorState error={put.error} />}
        </>
      )}
      {remove.error && <ErrorState error={remove.error} />}
    </div>
  );
}
