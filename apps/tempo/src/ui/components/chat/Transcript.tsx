import { ScrollArea } from "~/ui/components/ui/scroll-area";
import { useWorkspace } from "~/ui/hooks/useWorkspace";

export interface TranscriptProps {
  readonly workspaceId: string;
  readonly sessionId: string;
}

/** REGION B placeholder: the session's items as plain text (04, Transcript). */
export function Transcript({ workspaceId, sessionId }: TranscriptProps) {
  const ws = useWorkspace(workspaceId);
  const ids = ws.order[sessionId] ?? [];
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-2 p-3" aria-live="polite">
        {ids.map((id) => {
          const item = ws.items[id];
          if (!item) return null;
          const text = "text" in item.content ? item.content.text : item.kind.replace("_", " ");
          return (
            <div key={id} className={item.kind === "user_message" ? "self-end rounded-md bg-muted px-2 py-1" : ""}>
              <p className="text-sm whitespace-pre-wrap">{text}</p>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
