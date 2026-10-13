import { useState } from "react";
import { useCallQuery } from "~/ui/hooks/useCall";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { ErrorState, SkeletonRows } from "~/ui/components/shell/States";
export function LifecycleEvents({ workspaceId }: { workspaceId: string }) {
  const [changeId, setChangeId] = useState("");
  const [eventId, setEventId] = useState("");
  const events = useCallQuery("listLifecycleEvents", {
    workspaceId,
    limit: 500,
    ...(changeId.trim() ? { changeId: changeId.trim() } : {}),
  });
  const trace = useCallQuery("getTrace", { workspaceId, eventId }, { enabled: !!eventId });
  const roles = useCallQuery("listRoles", { workspaceId });
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
          <h3 className="font-medium">Role filters</h3>
          <pre className="text-xs whitespace-pre-wrap">
            {JSON.stringify(
              roles.data?.map((r) => ({
                name: r.name,
                scope: r.scope,
                on: r.on,
                error: r.error,
                shadowedBy: r.shadowedBy,
              })),
              null,
              2,
            )}
          </pre>
        </section>
      )}
    </div>
  );
}
