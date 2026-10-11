import type { CenterTabProps } from "~/ui/components/chat/tab-kinds";

/** REGION C placeholder: a preview inside Tempo (⌥-click on a port link). */
export function BrowserTab({ tab }: CenterTabProps<"browser">) {
  return <iframe
      title="Preview"
      src={tab.url}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
      className="h-full w-full border-0 bg-background"
    />;
}
