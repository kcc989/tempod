import { ExternalLinkIcon, GlobeIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import type { CenterTabProps } from "~/ui/components/chat/tab-kinds";
import { EmptyState } from "~/ui/components/shell/States";
import { openPreviewTab } from "~/ui/components/topbar/open-preview";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { call } from "~/ui/lib/api";
import { errorText } from "~/ui/lib/toast";
import { normalizeUrl, PREVIEW_SANDBOX, previewPortOf, safeHttpUrl } from "./browser-model";

/**
 * A preview inside Tempo (⌥-click on a port link): an address bar, reload and the page. A preview
 * of this workspace loads the entry link from openPreview (04, Browser tabs).
 */
export function BrowserTab({ workspaceId, tab, seq }: CenterTabProps<"browser">) {
  const url = safeHttpUrl(tab.url);
  if (!url)
    return <EmptyState className="h-full" icon={GlobeIcon} title="Only web addresses can open here." />;
  return (
    <BrowserView
      key={`${url}\u0000${seq}`}
      url={url}
      workspaceId={workspaceId}
      port={previewPortOf(url, workspaceId)}
    />
  );
}

function BrowserView({ url, workspaceId, port }: { url: string; workspaceId: string; port: number | null }) {
  const inputId = useId();
  // `entry`: src is a one-time entry link, so a reload needs a new one.
  const [src, setSrc] = useState<{ url: string; entry: boolean } | null>(
    port === null ? { url, entry: false } : null,
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [text, setText] = useState(url);
  const [invalid, setInvalid] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (port === null) return;
    let live = true;
    call("openPreview", { workspaceId, port }).then(
      (r) => {
        if (live) setSrc((cur) => cur ?? { url: r.url, entry: true });
      },
      (e: unknown) => {
        if (live) setFailure(errorText(e));
      },
    );
    return () => {
      live = false;
    };
  }, [workspaceId, port, attempt]);

  const reload = () => {
    if (port !== null && (src === null || src.entry)) {
      setSrc(null);
      setFailure(null);
      setAttempt((a) => a + 1);
    } else setNonce((n) => n + 1);
  };

  const go = (e: FormEvent) => {
    e.preventDefault();
    const next = normalizeUrl(text, src && !src.entry ? src.url : url);
    if (!next) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setFailure(null);
    setText(next);
    if (src?.url === next) setNonce((n) => n + 1);
    else setSrc({ url: next, entry: false });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form onSubmit={go} className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <SimpleTooltip label="Reload">
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Reload" onClick={reload}>
            <RotateCwIcon />
          </Button>
        </SimpleTooltip>
        <label htmlFor={inputId} className="sr-only">
          Address
        </label>
        <Input
          id={inputId}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setInvalid(false);
          }}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${inputId}-error` : undefined}
          spellCheck={false}
          autoComplete="off"
          className="h-6 flex-1 font-mono text-xs"
        />
        {invalid && (
          <span id={`${inputId}-error`} role="alert" className="shrink-0 text-xs text-destructive">
            Enter a web address.
          </span>
        )}
        <SimpleTooltip label="Open in a new tab">
          <Button asChild size="icon-sm" variant="ghost">
            <a
              href={port === null ? (src?.url ?? url) : url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open in a new tab"
              onClick={(e) => {
                if (port === null) return;
                e.preventDefault();
                void openPreviewTab(workspaceId, port);
              }}
            >
              <ExternalLinkIcon />
            </a>
          </Button>
        </SimpleTooltip>
      </form>
      {src ? (
        <iframe
          key={nonce}
          title="Preview"
          src={src.url}
          sandbox={PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0 bg-background"
        />
      ) : failure ? (
        <EmptyState className="min-h-0 flex-1" icon={GlobeIcon} title={failure} />
      ) : (
        <div aria-busy="true" className="min-h-0 flex-1 bg-background" />
      )}
    </div>
  );
}
