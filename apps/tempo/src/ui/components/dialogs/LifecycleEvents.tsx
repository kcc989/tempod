import { useState } from "react";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { useCallQuery } from "~/ui/hooks/useCall";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { ErrorState, SkeletonRows } from "~/ui/components/shell/States";

export function LifecycleEvents({ workspaceId }: { workspaceId: string }) {
  const [changeId, setChangeId] = useState("");
  const [eventId, setEventId] = useState("");

  let input: import("@tempo/protocol").FnInput<"listLifecycleEvents"> = { workspaceId, limit: 500 };

  if (changeId.trim()) input = { ...input, changeId: changeId.trim() };
  const events = useCallQuery("listLifecycleEvents", input);

  const trace = useCallQuery("getTrace", { workspaceId, eventId }, { enabled: !!eventId });
  const projectId = useWorkspaceSelector(workspaceId, (s) => s.workspace?.projectId);

  const attachments = useCallQuery(
    "listProjectAgents",
    { projectId: projectId ?? "" },
    { enabled: !!projectId },
  );

  return (
    <div className="min-h-0 space-y-2 overflow-auto">
      <div className="flex gap-2">
        <Input
          aria-label="Filter events by change"
          placeholder="Change ID"
          value={changeId}
          onChange={(e) => setChangeId(e.target.value)}
        />
        <Button variant="outline" onClick={() => void events.refetch()}>
          Refresh
        </Button>
      </div>
      {events.isPending ? (
        <SkeletonRows rows={6} />
      ) : events.isError ? (
        <ErrorState error={events.error} onRetry={() => void events.refetch()} />
      ) : (
        <ul>
          {events.data?.events.map(({ seq, event }) => (
            <li key={event.id}>
              <Button
                variant="ghost"
                className="h-auto text-left text-xs"
                onClick={() => setEventId(event.id)}
              >
                {seq} · {event.type} · {event.agent ?? event.source} · {event.changeId ?? "No change"}
                {event.type === "run.decided" && (
                  <span className="ml-2">
                    {event.payload.handle} · {event.payload.outcome} ·{" "}
                    {event.payload.p === undefined
                      ? event.payload.outcome === "error"
                        ? "No answer"
                        : "Always"
                      : `${Math.round(event.payload.p * 100)}%`}{" "}
                    · threshold {event.payload.threshold} ·{" "}
                    {attachments.data?.find((a) => a.id === event.payload.attachmentId)?.hooks[
                      event.payload.hookIndex
                    ]?.when ?? "Always / hook removed"}
                  </span>
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {eventId && (
        <section aria-label="Event trace">
          <h3 className="font-medium">Trace</h3>
          {trace.isError ? (
            <ErrorState error={trace.error} onRetry={() => void trace.refetch()} />
          ) : (
            <pre className="overflow-auto text-xs whitespace-pre-wrap">
              {JSON.stringify(trace.data, null, 2)}
            </pre>
          )}
          <h3 className="font-medium">Agent hooks</h3>
          <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(attachments.data, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}
