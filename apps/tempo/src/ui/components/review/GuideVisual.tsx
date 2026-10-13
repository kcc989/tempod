import { Match } from "effect";
import type { GuideVisual as Visual } from "@tempo/protocol";
import { useState } from "react";
import { MessageMarkdown } from "~/ui/components/chat/Markdown";
import { Button } from "~/ui/components/ui/button";
import { useCallQuery } from "~/ui/hooks/useCall";
import { errorText } from "~/ui/lib/toast";
import { openDiff } from "~/ui/state/workspace-ui";

export const ARTIFACT_SANDBOX = "allow-scripts";

export const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export const isolatedArtifact = (html: string): string =>
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta name="referrer" content="no-referrer">${html}`;

const imageMime = (path: string): string | null => {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();

  return (
    { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[ext] ??
    null
  );
};

export function GuideVisual({
  workspaceId,
  visual,
  live,
}: {
  workspaceId: string;
  visual: Visual;
  live: boolean;
}) {
  return (
    <section aria-label={visual.title} className="overflow-hidden rounded-md border">
      <h4 className="border-b bg-muted/30 px-3 py-2 text-sm font-medium">{visual.title}</h4>
      {Match.value(visual).pipe(
        Match.when({ kind: "comparison" }, (visual) => (
          <Comparison workspaceId={workspaceId} before={visual.before} after={visual.after} />
        )),
        Match.when({ kind: "flow" }, (visual) => <Flow workspaceId={workspaceId} visual={visual} />),
        Match.orElse((visual) => <Artifact workspaceId={workspaceId} visual={visual} live={live} />),
      )}
    </section>
  );
}

export function Comparison({
  workspaceId,
  before,
  after,
}: {
  workspaceId: string;
  before: string;
  after: string;
}) {
  const [side, setSide] = useState<"before" | "after" | "both">("both");

  return (
    <div>
      <div className="flex gap-1 border-b p-1" role="group" aria-label="Before and after view">
        {(["before", "after", "both"] as const).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={side === s ? "secondary" : "ghost"}
            aria-pressed={side === s}
            onClick={() => setSide(s)}
          >
            {Match.value(s).pipe(
              Match.when("both", () => "Side by side"),
              Match.when("before", () => "Before"),
              Match.orElse(() => "After"),
            )}
          </Button>
        ))}
      </div>
      <div
        className={
          side === "both" ? "grid grid-cols-1 divide-y md:grid-cols-2 md:divide-x md:divide-y-0" : ""
        }
      >
        {side !== "after" && (
          <div className="p-3">
            <h5 className="mb-2 text-xs font-medium text-muted-foreground">Before</h5>
            <MessageMarkdown workspaceId={workspaceId} text={before} streaming={false} />
          </div>
        )}
        {side !== "before" && (
          <div className="p-3">
            <h5 className="mb-2 text-xs font-medium text-muted-foreground">After</h5>
            <MessageMarkdown workspaceId={workspaceId} text={after} streaming={false} />
          </div>
        )}
      </div>
    </div>
  );
}

function Flow({ workspaceId, visual }: { workspaceId: string; visual: Extract<Visual, { kind: "flow" }> }) {
  const [selected, setSelected] = useState(visual.nodes[0]!.id);
  const node = visual.nodes.find((n) => n.id === selected) ?? visual.nodes[0]!;

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Flow nodes">
        {visual.nodes.map((n) => (
          <Button
            key={n.id}
            variant={node.id === n.id ? "secondary" : "outline"}
            size="sm"
            aria-pressed={node.id === n.id}
            onClick={() => setSelected(n.id)}
          >
            {n.label}
          </Button>
        ))}
      </div>
      {visual.edges.length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground" aria-label="Connections">
          {visual.edges.map((e, i) => (
            <li key={i}>
              {visual.nodes.find((n) => n.id === e.from)?.label} →{" "}
              {visual.nodes.find((n) => n.id === e.to)?.label} · {e.label}
            </li>
          ))}
        </ul>
      )}
      <div className="rounded-md bg-muted/30 p-3" aria-live="polite">
        <h5 className="mb-1 font-medium">{node.label}</h5>
        <MessageMarkdown workspaceId={workspaceId} text={node.description} streaming={false} />
        {node.path && (
          <Button
            size="sm"
            variant="link"
            className="mt-2 px-0"
            onClick={() => openDiff(workspaceId, node.path!)}
          >
            Open diff: {node.path}
          </Button>
        )}
      </div>
    </div>
  );
}

function Artifact({
  workspaceId,
  visual,
  live,
}: {
  workspaceId: string;
  visual: Extract<Visual, { path: string }>;
  live: boolean;
}) {
  const [opened, setOpened] = useState(false);

  const file = useCallQuery(
    "readFile",
    { workspaceId, path: visual.path },
    {
      enabled: opened && live,
      retry: false,
    },
  );

  const mime = imageMime(visual.path);
  let body;

  if (!opened) {
    body = (
      <Button size="sm" variant="outline" disabled={!live} onClick={() => setOpened(true)}>
        Open artifact
      </Button>
    );
  } else if (file.isError) {
    body = (
      <div role="alert" className="space-y-2 text-sm">
        <p>{errorText(file.error)}</p>
        <Button size="sm" variant="outline" disabled={!live} onClick={() => void file.refetch()}>
          Retry
        </Button>
      </div>
    );
  } else if (!file.data) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        {live ? "Loading artifact…" : "Wake to load this artifact."}
      </p>
    );
  } else if (visual.kind === "image" && mime && file.data.encoding === "base64") {
    body = (
      <img
        src={`data:${mime};base64,${file.data.content}`}
        alt={visual.title}
        className="max-h-[32rem] max-w-full rounded object-contain"
      />
    );
  } else if (file.data.encoding !== "utf8" || visual.kind === "image") {
    body = (
      <p role="alert" className="text-sm">
        This artifact has an unsupported format.
      </p>
    );
  } else if (visual.kind === "html") {
    body = (
      <iframe
        title={visual.title}
        sandbox={ARTIFACT_SANDBOX}
        srcDoc={isolatedArtifact(file.data.content)}
        referrerPolicy="no-referrer"
        className="h-[28rem] w-full rounded border bg-background"
      />
    );
  } else {
    body = <MessageMarkdown workspaceId={workspaceId} text={file.data.content} streaming={false} />;
  }

  return (
    <div className="space-y-2 p-3">
      {visual.caption && (
        <MessageMarkdown workspaceId={workspaceId} text={visual.caption} streaming={false} />
      )}
      {!live && <p className="text-xs text-muted-foreground">Wake the workspace to load artifacts.</p>}
      {body}
    </div>
  );
}
