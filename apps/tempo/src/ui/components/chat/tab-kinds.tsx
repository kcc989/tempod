import * as Icons from "lucide-react";
import {
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

  const run = useWorkspaceSelector(workspaceId, (s) =>
    session?.roleRunId ? s.roleRuns[session.roleRunId] : undefined,
  );

  if (run)
    return (
      <>
        {run.roleName} #{run.round} · {run.status}
      </>
    );
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
export const CENTER_TAB_KINDS = {
  chat: { icon: MessageSquareIcon, Title: ChatTitle, Body: ChatBody },
  file: { icon: FileCodeIcon, Title: ({ tab }) => <>{baseName(tab.path)}</>, Body: FileTab },
  diff: { icon: FileDiffIcon, Title: () => <>Diff</>, Body: DiffTab },
  guide: { icon: BookOpenIcon, Title: () => <>Guide</>, Body: GuideTab },
  browser: { icon: GlobeIcon, Title: ({ tab }) => <>{hostOf(tab.url)}</>, Body: BrowserTab },
  liveView: { icon: RadioIcon, Title: () => <>Live View</>, Body: LiveViewTab },
  artifact: { icon: Icons.ShapesIcon, Title: ArtifactTitle, Body: ArtifactTab },
} satisfies { readonly [K in CenterTabKind]: CenterTabKindDef<K> };

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
  switch (tab.kind) {
    case "chat":
      return renderTab<"chat">(CENTER_TAB_KINDS.chat, part, { workspaceId, tab, active, seq });
    case "file":
      return renderTab<"file">(CENTER_TAB_KINDS.file, part, { workspaceId, tab, active, seq });
    case "diff":
      return renderTab<"diff">(CENTER_TAB_KINDS.diff, part, { workspaceId, tab, active, seq });
    case "guide":
      return renderTab<"guide">(CENTER_TAB_KINDS.guide, part, { workspaceId, tab, active, seq });
    case "browser":
      return renderTab<"browser">(CENTER_TAB_KINDS.browser, part, { workspaceId, tab, active, seq });
    case "liveView":
      return renderTab<"liveView">(CENTER_TAB_KINDS.liveView, part, { workspaceId, tab, active, seq });
    case "artifact":
      return renderTab<"artifact">(CENTER_TAB_KINDS.artifact, part, { workspaceId, tab, active, seq });
  }
}

const renderTab = <K extends CenterTabKind>(
  definition: CenterTabKindDef<K>,
  part: "Title" | "Body",
  props: CenterTabProps<K>,
) => {
  const Part = definition[part];

  return <Part {...props} />;
};
