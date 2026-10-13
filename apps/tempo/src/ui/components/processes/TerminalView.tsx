import { reconnectDelay } from "@tempo/protocol";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Button } from "~/ui/components/ui/button";
import { LoadingText } from "~/ui/components/ui/spinner";
import { useTheme } from "~/ui/hooks/useTheme";
import { wsUrl } from "~/ui/lib/socket";
import {
  encodeBinary,
  encodeInput,
  isReadyFrame,
  resizeFrame,
  TERMINAL_CLOSE_TEXT,
  terminalCloseAction,
  terminalPath,
  type TerminalClose,
  type TerminalId,
} from "./terminal-model";
import { terminalFont, terminalTheme } from "./terminal-theme";

type Status =
  | "loading"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "failed"
  | Exclude<TerminalClose, "reconnect">;

const RESIZE_DEBOUNCE_MS = 100;

/**
 * One xterm over the terminal channel (01, Terminal): keystrokes as binary frames, resize as a
 * text frame, input only after `{"type":"ready"}`. It reconnects with the channel backoff; tmux
 * keeps the shell, so the screen is reset and redrawn on each new connection.
 */
export function TerminalView({
  workspaceId,
  terminalId,
  active,
  focusSeq,
}: {
  workspaceId: string;
  terminalId: TerminalId;
  active: boolean;
  focusSeq: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [generation, setGeneration] = useState(0);
  const { resolved } = useTheme();
  const focusWhenReady = useEffectEvent(() => {
    if (active && focusSeq > 0) term.current?.focus();
  });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let t: Terminal | null = null;
    let fit: FitAddon | null = null;
    let ws: WebSocket | null = null;
    let ready = false;
    let attempts = 0;
    let connections = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: ResizeObserver | null = null;
    let reconnectAllowed = true;

    const send = (data: Uint8Array | string) => {
      if (ws && ready && ws.readyState === WebSocket.OPEN) ws.send(data);
    };

    const safeFit = () => {
      if (!fit || el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        // Not measurable yet; the next resize fits.
      }
    };

    const connect = () => {
      if (disposed || !t) return;
      setStatus(connections === 0 ? "connecting" : "reconnecting");
      const sock = new WebSocket(wsUrl(terminalPath(workspaceId, terminalId, t.cols, t.rows)));
      sock.binaryType = "arraybuffer";
      ws = sock;
      sock.onmessage = (e: MessageEvent) => {
        if (ws !== sock || !t) return;
        if (typeof e.data === "string") {
          if (!isReadyFrame(e.data)) return;
          if (connections > 0) t.reset();
          connections++;
          attempts = 0;
          ready = true;
          setStatus("ready");
          sock.send(resizeFrame(t.cols, t.rows));
          return;
        }
        t.write(new Uint8Array(e.data as ArrayBuffer));
      };
      sock.onclose = (e: CloseEvent) => {
        if (ws !== sock || disposed) return;
        ws = null;
        ready = false;
        const action = terminalCloseAction(e.code);
        if (action !== "reconnect") {
          reconnectAllowed = false;
          return setStatus(action);
        }
        setStatus("reconnecting");
        retry = setTimeout(connect, reconnectDelay(attempts++));
      };
    };

    const reconnectNow = () => {
      if (disposed || !t || !reconnectAllowed) return;
      if (retry) clearTimeout(retry);
      retry = null;
      const previous = ws;
      ws = null;
      ready = false;
      previous?.close(1000, "reconnecting");
      connect();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconnectNow();
    };
    window.addEventListener("online", reconnectNow);
    document.addEventListener("visibilitychange", onVisible);

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/xterm/css/xterm.css"),
      ]);
      if (disposed) return;
      t = new Terminal({
        fontFamily: terminalFont(),
        fontSize: 12,
        cursorBlink: true,
        scrollback: 5000,
        theme: terminalTheme(),
      });
      fit = new FitAddon();
      t.loadAddon(fit);
      t.open(el);
      term.current = t;
      focusWhenReady();
      safeFit();
      t.onData((d) => send(encodeInput(d)));
      t.onBinary((d) => send(encodeBinary(d)));
      t.onResize(({ cols, rows }) => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => send(resizeFrame(cols, rows)), RESIZE_DEBOUNCE_MS);
      });
      observer = new ResizeObserver(() => safeFit());
      observer.observe(el);
      connect();
    })().catch(() => {
      if (!disposed) setStatus("failed");
    });

    return () => {
      disposed = true;
      window.removeEventListener("online", reconnectNow);
      document.removeEventListener("visibilitychange", onVisible);
      if (retry) clearTimeout(retry);
      if (resizeTimer) clearTimeout(resizeTimer);
      observer?.disconnect();
      const sock = ws;
      ws = null;
      if (sock) {
        sock.onclose = null;
        sock.onmessage = null;
        try {
          sock.close(1000, "closed");
        } catch {
          // Already closed.
        }
      }
      t?.dispose();
      term.current = null;
    };
  }, [workspaceId, terminalId, generation]);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (term.current) term.current.options.theme = terminalTheme();
    });
    return () => cancelAnimationFrame(id);
  }, [resolved]);

  useEffect(() => {
    if (active && focusSeq > 0) term.current?.focus();
  }, [active, focusSeq]);

  const ended =
    status === "exited" || status === "replaced" || status === "notFound" || status === "badVersion";
  return (
    <div className="relative h-full w-full bg-background">
      <div
        ref={host}
        aria-label={`Terminal ${terminalId}`}
        className="absolute inset-0 overflow-hidden py-1 pl-2 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-ring"
      />
      {(status === "loading" || status === "connecting" || status === "reconnecting") && (
        <div className="pointer-events-none absolute top-1 right-2 rounded-md bg-background/90 px-2 py-0.5">
          <LoadingText
            label={status === "reconnecting" ? "Reconnecting…" : "Connecting…"}
            className="text-xs"
          />
        </div>
      )}
      {(ended || status === "failed") && (
        <div
          role="status"
          className="absolute inset-x-0 bottom-0 flex items-center gap-2 border-t bg-background/95 px-3 py-1.5 text-sm"
        >
          <span>
            {status === "failed"
              ? "The terminal could not load."
              : TERMINAL_CLOSE_TEXT[status as keyof typeof TERMINAL_CLOSE_TEXT]}
          </span>
          {status === "badVersion" ? (
            <Button size="sm" variant="outline" onClick={() => globalThis.location?.reload()}>
              Reload
            </Button>
          ) : status !== "notFound" ? (
            <Button size="sm" variant="outline" onClick={() => setGeneration((g) => g + 1)}>
              {status === "exited" ? "Start a new shell" : "Reconnect"}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
