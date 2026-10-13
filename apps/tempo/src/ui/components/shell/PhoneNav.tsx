import { useNavigate, useParams } from "@tanstack/react-router";
import { FileDiffIcon, LayoutListIcon, MessageSquareIcon } from "lucide-react";
import type { ComponentType } from "react";
import { useLayout } from "~/ui/hooks/useWorkspaceUi";
import { cn } from "~/ui/lib/utils";
import { setPhonePane, type PhonePane } from "~/ui/state/workspace-ui";

/** 04, Phone width: bottom navigation Workspaces, Chat, Changes. */
export function PhoneNav() {
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const { phonePane, lastWorkspaceId } = useLayout();
  const current = params.workspaceId ?? null;
  const target = current ?? lastWorkspaceId;

  const showPane = (pane: PhonePane) => {
    setPhonePane(pane);

    if (!current && target) void navigate({ to: "/w/$workspaceId", params: { workspaceId: target } });
  };

  return (
    <nav
      aria-label="Sections"
      className="grid shrink-0 grid-cols-3 border-t bg-sidebar pb-[env(safe-area-inset-bottom)]"
    >
      <NavButton
        icon={LayoutListIcon}
        label="Workspaces"
        active={current === null}
        onClick={() => void navigate({ to: "/" })}
      />
      <NavButton
        icon={MessageSquareIcon}
        label="Chat"
        active={current !== null && phonePane === "chat"}
        disabled={target === null}
        onClick={() => showPane("chat")}
      />
      <NavButton
        icon={FileDiffIcon}
        label="Changes"
        active={current !== null && phonePane === "changes"}
        disabled={target === null}
        onClick={() => showPane("changes")}
      />
    </nav>
  );
}

function NavButton({
  icon: Icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-12 flex-col items-center justify-center gap-0.5 text-xs text-muted-foreground outline-none focus-visible:bg-accent disabled:opacity-40",
        active && "text-foreground",
      )}
    >
      <Icon className="size-4" />
      {label}
    </button>
  );
}
