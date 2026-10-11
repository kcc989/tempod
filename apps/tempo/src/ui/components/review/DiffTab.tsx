import type { CenterTabProps } from "~/ui/components/chat/tab-kinds";
import { EmptyState } from "~/ui/components/shell/States";

/** REGION C placeholder: the Diff tab (center). `tab.path` is the file to show first. */
export function DiffTab({ tab }: CenterTabProps<"diff">) {
  return <EmptyState className="h-full" title="Diff" description={tab.path ?? undefined} />;
}
