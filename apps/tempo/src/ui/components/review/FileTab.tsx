import type { CenterTabProps } from "~/ui/components/chat/tab-kinds";
import { ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { ScrollArea } from "~/ui/components/ui/scroll-area";
import { useCallQuery } from "~/ui/hooks/useCall";

/** REGION C placeholder: a read-only file tab (readFile). `tab.line` is the line to reveal. */
export function FileTab({ workspaceId, tab }: CenterTabProps<"file">) {
  const file = useCallQuery("readFile", { workspaceId, path: tab.path });
  if (file.isPending) return <SkeletonRows />;
  if (file.isError) return <ErrorState error={file.error} onRetry={() => void file.refetch()} />;
  return (
    <ScrollArea className="h-full">
      <pre className="p-3 font-mono text-xs whitespace-pre">
        {file.data.encoding === "utf8" ? file.data.content : "Binary file."}
      </pre>
    </ScrollArea>
  );
}
