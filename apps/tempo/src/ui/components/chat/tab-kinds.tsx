import {
  ShapesIcon,
  BookOpenIcon,
  FileCodeIcon,
  FileDiffIcon,
  GlobeIcon,
  MessageSquareIcon,
  RadioIcon,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { sessionTitle, sessionTooltip } from "~/ui/components/chat/chat-tabs-model";
import { ArtifactTab, ArtifactTitle } from "~/ui/components/artifacts/ArtifactTab";
import { Composer } from "~/ui/components/chat/Composer";
import { Transcript } from "~/ui/components/chat/Transcript";
import { BrowserTab } from "~/ui/components/review/BrowserTab";
import { DiffTab } from "~/ui/components/review/DiffTab";
import { FileTab } from "~/ui/components/review/FileTab";
import { GuideTab } from "~/ui/components/review/GuideTab";
import { LiveViewTab } from "~/ui/components/review/LiveViewTab";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import type { CenterTab, CenterTabKind } from "~/ui/state/workspace-ui";

/** Props every center tab body and title get. */
export interface CenterTabProps<K extends CenterTabKind = CenterTabKind> {
  readonly workspaceId: string;
  readonly tab: Extract<CenterTab, { kind: K }>;
  readonly active: boolean;
  /** Increments each time the tab is opened again (scroll to the new line or file). */
  readonly seq: number;
}

export interface CenterTabKindDef<K extends CenterTabKind> {
  readonly icon: LucideIcon;
  /** The tab's label in the tab bar. */
  readonly Title: ComponentType<CenterTabProps<K>>;
  /** The tab's content, rendered while the tab is active. */
  readonly Body: ComponentType<CenterTabProps<K>>;
}

function ChatTitle({ workspaceId, tab }: CenterTabProps<"chat">) {
  const session = useWorkspaceSelector(workspaceId, (s) => s.sessions[tab.sessionId]);
  const tooltip = sessionTooltip(session);
  return tooltip ? <span title={tooltip}>{sessionTitle(session)}</span> : <>{sessionTitle(session)}</>;
}

function ChatBody({ workspaceId, tab }: CenterTabProps<"chat">) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <Transcript workspaceId={workspaceId} sessionId={tab.sessionId} />
      </div>
      <Composer workspaceId={workspaceId} sessionId={tab.sessionId} />
    </div>
  );
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The tab-kind registry: how each kind of center tab renders. Chat is region B; the rest region C. */
export const CENTER_TAB_KINDS: { readonly [K in CenterTabKind]: CenterTabKindDef<K> } = {
  chat: { icon: MessageSquareIcon, Title: ChatTitle, Body: ChatBody },
  file: { icon: FileCodeIcon, Title: ({ tab }) => <>{baseName(tab.path)}</>, Body: FileTab },
  diff: { icon: FileDiffIcon, Title: () => <>Diff</>, Body: DiffTab },
  guide: { icon: BookOpenIcon, Title: () => <>Guide</>, Body: GuideTab },
  browser: { icon: GlobeIcon, Title: ({ tab }) => <>{hostOf(tab.url)}</>, Body: BrowserTab },
  liveView: { icon: RadioIcon, Title: () => <>Live View</>, Body: LiveViewTab },
  artifact: { icon: ShapesIcon, Title: ArtifactTitle, Body: ArtifactTab },
};

/** Renders a tab's title or body through the registry with the right prop types. */
export function CenterTabPart({
  part,
  workspaceId,
  tab,
  active,
  seq,
}: {
  part: "Title" | "Body";
  workspaceId: string;
  tab: CenterTab;
  active: boolean;
  seq: number;
}) {
  const def = CENTER_TAB_KINDS[tab.kind] as unknown as CenterTabKindDef<CenterTabKind>;
  const Part = def[part];
  return <Part workspaceId={workspaceId} tab={tab} active={active} seq={seq} />;
}
