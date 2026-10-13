import { Schema } from "effect";
import type { ConversationArtifact, Project } from "@tempo/protocol";
import { useState } from "react";
import { ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { useCallQuery } from "~/ui/hooks/useCall";
import { formatRelative } from "~/ui/lib/format";

export function ProjectConversations({ project }: { project: Project }) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | null>(null);

  let input: import("@tempo/protocol").FnInput<"listProjectConversations"> = { projectId: project.id };

  if (cursor) input = { ...input, cursor };
  const list = useCallQuery("listProjectConversations", input);

  return (
    <section className="border-b p-3" aria-label={`Saved conversations for ${project.owner}/${project.name}`}>
      <h2 className="mb-2 text-sm font-semibold">
        {project.owner}/{project.name}
      </h2>
      {list.isPending ? (
        <SkeletonRows rows={3} />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <>
          {list.data.conversations.length === 0 && (
            <p className="text-sm text-muted-foreground">No saved conversations.</p>
          )}
          <ul className="grid gap-1">
            {list.data.conversations.map((c) => (
              <li key={c.conversationId}>
                <Button
                  variant={selected === c.conversationId ? "secondary" : "ghost"}
                  className="h-auto w-full justify-start whitespace-normal text-left"
                  onClick={() => setSelected(c.conversationId)}
                >
                  <span>
                    {c.title || c.branch}{" "}
                    <span className="text-xs text-muted-foreground">
                      · {c.branch} · saved {formatRelative(c.updatedAt)}
                    </span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            {cursor && (
              <Button size="sm" variant="outline" onClick={() => setCursor(undefined)}>
                First page
              </Button>
            )}
            {list.data.cursor && (
              <Button size="sm" variant="outline" onClick={() => setCursor(list.data.cursor!)}>
                Next page
              </Button>
            )}
          </div>
        </>
      )}
      {selected && (
        <SavedConversation
          key={selected}
          projectId={project.id}
          conversationId={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

function SavedConversation({
  projectId,
  conversationId,
  onClose,
}: {
  projectId: string;
  conversationId: string;
  onClose: () => void;
}) {
  const result = useCallQuery("getProjectConversation", { projectId, conversationId });

  return (
    <div className="mt-3 rounded-md border p-3">
      <Button size="sm" variant="outline" onClick={onClose}>
        Close conversation
      </Button>
      {result.isPending ? (
        <SkeletonRows rows={5} />
      ) : result.isError ? (
        <ErrorState error={result.error} onRetry={() => void result.refetch()} />
      ) : (
        <SavedTranscript artifact={result.data} />
      )}
    </div>
  );
}

function SavedTranscript({ artifact }: { artifact: ConversationArtifact }) {
  const [page, setPage] = useState(0);
  const PAGE = 100;

  return (
    <>
      <h3 className="my-3 text-sm font-semibold">{artifact.title || artifact.branch}</h3>
      <ol className="grid gap-3" aria-label="Saved transcript">
        {artifact.items.slice(page * PAGE, (page + 1) * PAGE).map((item) => {
          const session = artifact.sessions.find((s) => s.id === item.sessionId);

          const text =
            "text" in item.content && Schema.is(Schema.String)(item.content.text) ? item.content.text : null;

          return (
            <li key={item.id} className="rounded border p-2">
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {session?.title || session?.agent || "Chat"} · {item.kind.replaceAll("_", " ")} ·{" "}
                {item.status}
              </p>
              {text !== null ? (
                <p className="whitespace-pre-wrap break-words text-sm">{text}</p>
              ) : (
                <details>
                  <summary className="cursor-pointer text-sm">View details</summary>
                  <pre className="overflow-auto whitespace-pre-wrap break-all text-xs">
                    {JSON.stringify(item.content, null, 2)}
                  </pre>
                </details>
              )}
            </li>
          );
        })}
      </ol>
      <div className="mt-3 flex items-center gap-2 text-sm">
        <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>
          Previous messages
        </Button>
        <span>Page {page + 1}</span>
        <Button
          size="sm"
          variant="outline"
          disabled={(page + 1) * PAGE >= artifact.items.length}
          onClick={() => setPage(page + 1)}
        >
          Next messages
        </Button>
      </div>
    </>
  );
}
