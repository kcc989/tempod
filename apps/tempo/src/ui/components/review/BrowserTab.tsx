import { ExternalLinkIcon, GlobeIcon, RotateCwIcon } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import type { CenterTabProps } from "~/ui/components/chat/tab-kinds";
import { EmptyState } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { normalizeUrl, PREVIEW_SANDBOX, safeHttpUrl } from "./browser-model";

/** A preview inside Tempo (⌥-click on a port link): an address bar, reload and the page. */
export function BrowserTab({ tab, seq }: CenterTabProps<"browser">) {
  const url = safeHttpUrl(tab.url);
  if (!url)
    return <EmptyState className="h-full" icon={GlobeIcon} title="Only web addresses can open here." />;
  return <BrowserView key={`${url}\u0000${seq}`} url={url} />;
}

function BrowserView({ url }: { url: string }) {
  const inputId = useId();
  const [src, setSrc] = useState(url);
  const [text, setText] = useState(url);
  const [invalid, setInvalid] = useState(false);
  const [nonce, setNonce] = useState(0);

  const go = (e: FormEvent) => {
    e.preventDefault();
    const next = normalizeUrl(text, src);
    if (!next) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setText(next);
    if (next === src) setNonce((n) => n + 1);
    else setSrc(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form onSubmit={go} className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <SimpleTooltip label="Reload">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Reload"
            onClick={() => setNonce((n) => n + 1)}
          >
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
            <a href={src} target="_blank" rel="noopener noreferrer" aria-label="Open in a new tab">
              <ExternalLinkIcon />
            </a>
          </Button>
        </SimpleTooltip>
      </form>
      <iframe
        key={nonce}
        title="Preview"
        src={src}
        sandbox={PREVIEW_SANDBOX}
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0 bg-background"
      />
    </div>
  );
}
