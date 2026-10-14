import { LifecycleEvents } from "./LifecycleEvents";
import { Schema } from "effect";
import {
  ERROR_CODES,
  ERROR_MESSAGES,
  type Diagnostics,
  type EgressStatusFilter,
  type ErrorCode,
} from "@tempo/protocol";
import { keepPreviousData } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { RefreshCwIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/ui/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/ui/components/ui/dialog";
import { Input } from "~/ui/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/components/ui/tabs";
import { useCallQuery } from "~/ui/hooks/useCall";
import { useDebounced } from "~/ui/hooks/useDebounced";
import { useDialog } from "~/ui/hooks/useWorkspaceUi";
import { agentLabel } from "~/ui/lib/agents";
import { formatBytes, formatDateTime, formatDuration, formatTime } from "~/ui/lib/format";
import { cn } from "~/ui/lib/utils";
import {
  capabilityList,
  diagnosticsInput,
  EGRESS_HOST_DEBOUNCE_MS,
  EGRESS_STATUS_FILTERS,
  egressTone,
  hasEgressFilter,
  isBlocked,
  isEgressStatusFilter,
  logTone,
  opTone,
  timingRows,
  type Tone,
} from "./diagnostics-model";

const TONE_BADGE: Record<Tone, "success" | "warning" | "danger" | "muted"> = {
  ok: "success",
  warn: "warning",
  bad: "danger",
  muted: "muted",
};

const TONE_TEXT: Record<Tone, string> = {
  ok: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
  muted: "text-muted-foreground",
};

const isErrorCode = (c: string): c is ErrorCode => ERROR_CODES.some((value) => value === c);

/** 05, Diagnostics view: ops, container, logs, egress and sessions of one workspace. */
export function DiagnosticsDialog() {
  const { open, args, onOpenChange } = useDialog("diagnostics");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(46rem,calc(100dvh-2rem))] grid-rows-[auto_minmax(0,1fr)] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Diagnostics</DialogTitle>
          <DialogDescription className="sr-only">
            Ops, container, logs, egress and sessions.
          </DialogDescription>
        </DialogHeader>
        {args && <Body workspaceId={args.workspaceId} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({ workspaceId }: { workspaceId: string }) {
  const [host, setHost] = useState("");
  const [status, setStatus] = useState<EgressStatusFilter>("all");
  const egressHost = useDebounced(host, EGRESS_HOST_DEBOUNCE_MS);

  const d = useCallQuery("getDiagnostics", diagnosticsInput(workspaceId, egressHost, status), {
    placeholderData: keepPreviousData,
  });

  if (d.isPending) return <SkeletonRows rows={8} />;

  if (d.isError) return <ErrorState error={d.error} onRetry={() => void d.refetch()} />;
  const data = d.data;

  return (
    <Tabs defaultValue="ops" className="min-h-0 gap-2">
      <div className="flex items-center gap-2">
        <TabsList
          variant="line"
          aria-label="Diagnostics"
          className="min-w-0 flex-1 justify-start overflow-x-auto"
        >
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="ops">Ops</TabsTrigger>
          <TabsTrigger value="container">Container</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="egress">Egress</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
        </TabsList>
        <Button size="sm" variant="ghost" disabled={d.isFetching} onClick={() => void d.refetch()}>
          <RefreshCwIcon aria-hidden className={cn(d.isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>
      <TabsContent value="events" className="min-h-0 overflow-auto">
        <LifecycleEvents workspaceId={workspaceId} />
      </TabsContent>
      <TabsContent value="ops" className="min-h-0 overflow-y-auto">
        <Ops ops={data.ops} />
      </TabsContent>
      <TabsContent value="container" className="min-h-0 overflow-y-auto">
        <Container container={data.container} />
      </TabsContent>
      <TabsContent value="logs" className="min-h-0 overflow-y-auto">
        <Logs logs={data.logs} />
      </TabsContent>
      <TabsContent value="egress" className="flex min-h-0 flex-col gap-2">
        <Egress
          rows={data.egress}
          host={host}
          status={status}
          onHost={setHost}
          onStatus={setStatus}
          filtered={hasEgressFilter(egressHost, status)}
        />
      </TabsContent>
      <TabsContent value="sessions" className="min-h-0 overflow-y-auto">
        <Sessions sessions={data.sessions} />
      </TabsContent>
    </Tabs>
  );
}

function ErrorLine({ code, detail }: { code: string | null; detail: string | null }) {
  if (!code && !detail) return null;

  return (
    <div className="grid gap-0.5 text-xs">
      {code && (
        <p className="text-destructive">
          <span className="font-mono">{code}</span>
          {isErrorCode(code) ? ` · ${ERROR_MESSAGES[code]}` : ""}
        </p>
      )}
      {detail && (
        <pre className="max-h-32 overflow-auto rounded-sm bg-muted/50 p-1.5 font-mono break-all whitespace-pre-wrap">
          {detail}
        </pre>
      )}
    </div>
  );
}

function Ops({ ops }: { ops: Diagnostics["ops"] }) {
  if (ops.length === 0) return <EmptyState title="No ops yet." />;

  return (
    <ul className="flex flex-col divide-y rounded-md border">
      {ops.map((op) => {
        const timings = timingRows(op.timings);
        const total = timings.reduce((n, t) => n + t.ms, 0);

        return (
          <li key={op.id}>
            <Collapsible>
              <CollapsibleTrigger className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2">
                <Badge variant={TONE_BADGE[opTone(op.status)]}>{op.status}</Badge>
                <span className="font-medium">{op.kind}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                  {op.step}
                </span>
                {op.attempt > 1 && (
                  <span className="text-xs text-muted-foreground">attempt {op.attempt}</span>
                )}
                {total > 0 && <span className="text-xs text-muted-foreground">{formatDuration(total)}</span>}
                <span className="text-xs text-muted-foreground">{formatDateTime(op.createdAt)}</span>
              </CollapsibleTrigger>
              <CollapsibleContent className="grid gap-1.5 px-2 pb-2">
                {timings.length > 0 ? (
                  <table className="w-full text-xs">
                    <caption className="sr-only">Step timings</caption>
                    <tbody>
                      {timings.map((t) => (
                        <tr key={t.step}>
                          <td className="py-0.5 font-mono">{t.step}</td>
                          <td className="py-0.5 text-right text-muted-foreground">{formatDuration(t.ms)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-xs text-muted-foreground">No step timings.</p>
                )}
                <ErrorLine code={op.errorCode} detail={op.errorDetail} />
                <p className="font-mono text-xs text-muted-foreground">{op.id}</p>
              </CollapsibleContent>
            </Collapsible>
          </li>
        );
      })}
    </ul>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-2 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all">{children}</dd>
    </div>
  );
}

function Container({ container: c }: { container: Diagnostics["container"] }) {
  const instance = Schema.is(Schema.String)(c.instance) ? c.instance : JSON.stringify(c.instance);

  return (
    <div className="grid gap-3">
      <dl className="divide-y">
        <Row label="State">
          {c.state} · {c.running ? "running" : "not running"}
        </Row>
        <Row label="Instance">{instance}</Row>
        <Row label="Image">
          <span className="font-mono text-xs">{c.imageRef ?? "—"}</span>
        </Row>
        <Row label="tempod">{c.tempodVersion ?? "—"}</Row>
        <Row label="Incarnation">
          <span className="font-mono text-xs">{c.incarnation ?? "—"}</span>
        </Row>
      </dl>
      <section aria-labelledby="diag-snapshots" className="grid gap-1">
        <h3 id="diag-snapshots" className="text-sm font-semibold">
          Snapshots
        </h3>
        {c.snapshots.length === 0 ? (
          <p className="text-xs text-muted-foreground">No snapshots.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="py-1 font-medium">
                    Name
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Size
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Created
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Last restored
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Image
                  </th>
                </tr>
              </thead>
              <tbody>
                {c.snapshots.map((s) => (
                  <tr
                    key={s.id}
                    className={cn("border-b last:border-0", s.unusable && "text-muted-foreground")}
                  >
                    <td className="py-1 font-mono">
                      {s.name}
                      {s.unusable && (
                        <Badge variant="muted" className="ml-1">
                          unusable
                        </Badge>
                      )}
                    </td>
                    <td className="py-1">{formatBytes(s.sizeBytes)}</td>
                    <td className="py-1">{formatDateTime(s.createdAt)}</td>
                    <td className="py-1">{s.lastRestoredAt ? formatDateTime(s.lastRestoredAt) : "—"}</td>
                    <td className="max-w-48 truncate py-1 font-mono" title={s.imageRef}>
                      {s.imageRef}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Logs({ logs }: { logs: Diagnostics["logs"] }) {
  if (logs.length === 0) return <EmptyState title="No log events." />;

  return (
    <ul className="flex flex-col divide-y font-mono text-xs">
      {logs.map((l, i) => (
        <li key={`${l.ts}:${i}`} className="grid grid-cols-[5rem_3.5rem_minmax(0,1fr)] gap-2 py-1">
          <time
            className="text-muted-foreground"
            dateTime={new Date(l.ts).toISOString()}
            title={formatDateTime(l.ts)}
          >
            {formatTime(l.ts)}
          </time>
          <span className={TONE_TEXT[logTone(l.level)]}>{l.level}</span>
          <span className="min-w-0 break-words">
            {l.msg}
            {l.data !== undefined && (
              <span className="block break-all text-muted-foreground">{JSON.stringify(l.data)}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

const EGRESS_ROW_PX = 26;

/** The rows come filtered from the server (02 getDiagnostics), newest 500 matches. */
function Egress({
  rows,
  host,
  status,
  onHost,
  onStatus,
  filtered,
}: {
  rows: Diagnostics["egress"];
  host: string;
  status: EgressStatusFilter;
  onHost: (host: string) => void;
  onStatus: (status: EgressStatusFilter) => void;
  filtered: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line react/incompatible-library
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => EGRESS_ROW_PX,
    overscan: 12,
  });

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={host}
          onChange={(e) => onHost(e.target.value)}
          placeholder="Filter by host"
          aria-label="Filter by host"
          className="w-56"
        />
        <Select value={status} onValueChange={(v) => isEgressStatusFilter(v) && onStatus(v)}>
          <SelectTrigger aria-label="Filter by status" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EGRESS_STATUS_FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {rows.length} shown
        </span>
      </div>
      {rows.length === 0 ? (
        <EmptyState title={filtered ? "No matching requests." : "No requests yet."} />
      ) : (
        <div
          ref={scroller}
          tabIndex={0}
          role="region"
          aria-label="Egress log"
          className="min-h-0 flex-1 overflow-auto rounded-md border font-mono text-xs focus-visible:outline-2 focus-visible:-outline-offset-2"
        >
          <div
            role="table"
            aria-rowcount={rows.length}
            style={{ height: virtual.getTotalSize(), position: "relative" }}
          >
            {virtual.getVirtualItems().map((v) => {
              const r = rows[v.index]!;

              return (
                <div
                  key={v.key}
                  role="row"
                  aria-rowindex={v.index + 1}
                  className="absolute inset-x-0 grid grid-cols-[4.5rem_3.5rem_minmax(8rem,14rem)_minmax(0,1fr)_3rem_4rem] items-center gap-2 border-b px-2"
                  style={{ height: EGRESS_ROW_PX, transform: `translateY(${v.start}px)` }}
                >
                  <span role="cell" className="text-muted-foreground">
                    {formatTime(r.ts)}
                  </span>
                  <span role="cell">{r.method}</span>
                  <span role="cell" className="truncate" title={r.host}>
                    {r.host}
                  </span>
                  <span role="cell" className="truncate text-muted-foreground" title={r.path}>
                    {r.path}
                  </span>
                  <span
                    role="cell"
                    className={TONE_TEXT[egressTone(r)]}
                    title={isBlocked(r) ? `Blocked by rule ${r.rule}` : `Rule ${r.rule}`}
                  >
                    {r.status}
                  </span>
                  <span role="cell" className="text-right text-muted-foreground">
                    {formatDuration(r.ms)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

function Sessions({ sessions }: { sessions: Diagnostics["sessions"] }) {
  if (sessions.length === 0) return <EmptyState title="No sessions." />;

  return (
    <ul className="flex flex-col divide-y rounded-md border">
      {sessions.map((s) => {
        const caps = capabilityList(s.capabilities);

        return (
          <li key={s.id} className="grid gap-1 px-2 py-1.5 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">{agentLabel(s.agent)}</span>
              <Badge variant={s.live ? "success" : "muted"}>{s.live ? "Live" : "Not live"}</Badge>
              <span className="min-w-0 flex-1 truncate text-right font-mono text-xs text-muted-foreground">
                {s.acpSessionId ?? "No ACP session"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {caps.length > 0 ? caps.join(", ") : "No capabilities reported."}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
