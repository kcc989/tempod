import { reconnectDelay } from "@tempo/protocol";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
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
  terminalSize,
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
  const fitTerminal = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [generation, setGeneration] = useState(0);
  const { resolved } = useTheme();

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
    let fitFrame: number | null = null;
    let started = false;
    setStatus("loading");

    const send = (data: Uint8Array | string) => {
      if (ws && ready && ws.readyState === WebSocket.OPEN) ws.send(data);
    };

    const safeFit = () => {
      if (!fit || !t || el.clientWidth === 0 || el.clientHeight === 0) return false;
      try {
        const size = fit.proposeDimensions();
        if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return false;
        const { cols, rows } = terminalSize(size.cols, size.rows);
        t.resize(cols, rows);
        return true;
      } catch {
        // Not measurable yet; the next resize fits.
        return false;
      }
    };

    const connect = () => {
      if (disposed || !t) return;
      safeFit();
      ready = false;
      t.options.disableStdin = true;
      setStatus(connections === 0 ? "connecting" : "reconnecting");
      const sock = new WebSocket(wsUrl(terminalPath(workspaceId, terminalId, t.cols, t.rows)));
      sock.binaryType = "arraybuffer";
      ws = sock;
      sock.onmessage = (e: MessageEvent) => {
        if (ws !== sock || !t) return;
        if (typeof e.data === "string") {
          if (ready || !isReadyFrame(e.data)) return;
          if (connections > 0) t.write("\x1bc");
          connections++;
          attempts = 0;
          ready = true;
          t.options.disableStdin = false;
          setStatus("ready");
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = null;
          sock.send(resizeFrame(t.cols, t.rows));
          return;
        }
        if (ready) t.write(new Uint8Array(e.data as ArrayBuffer));
      };
      sock.onclose = (e: CloseEvent) => {
        if (ws !== sock || disposed) return;
        ws = null;
        ready = false;
        if (t) t.options.disableStdin = true;
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = null;
        const action = terminalCloseAction(e.code);
        if (action !== "reconnect") return setStatus(action);
        setStatus("reconnecting");
        retry = setTimeout(() => {
          retry = null;
          connect();
        }, reconnectDelay(attempts++));
      };
    };

    const scheduleFit = () => {
      if (disposed || fitFrame !== null) return;
      fitFrame = requestAnimationFrame(() => {
        fitFrame = null;
        if (!safeFit() || started) return;
        started = true;
        connect();
      });
    };
    fitTerminal.current = scheduleFit;

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
        disableStdin: true,
        scrollback: 5000,
        theme: terminalTheme(),
      });
      fit = new FitAddon();
      t.loadAddon(fit);
      t.open(el);
      term.current = t;
      t.onData((d) => send(encodeInput(d)));
      t.onBinary((d) => send(encodeBinary(d)));
      t.onResize(({ cols, rows }) => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => send(resizeFrame(cols, rows)), RESIZE_DEBOUNCE_MS);
      });
      observer = new ResizeObserver(scheduleFit);
      observer.observe(el);
      scheduleFit();
      void document.fonts?.ready.then(scheduleFit);
    })().catch(() => {
      if (!disposed) setStatus("failed");
    });

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      if (resizeTimer) clearTimeout(resizeTimer);
      if (fitFrame !== null) cancelAnimationFrame(fitFrame);
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
      fitTerminal.current = null;
    };
  }, [workspaceId, terminalId, generation]);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (term.current) term.current.options.theme = terminalTheme();
    });
    return () => cancelAnimationFrame(id);
  }, [resolved]);

  useEffect(() => {
    if (!active) return;
    fitTerminal.current?.();
    if (status === "ready") term.current?.focus();
  }, [active, focusSeq, status]);

  const ended =
    status === "exited" || status === "replaced" || status === "notFound" || status === "badVersion";
  return (
    <div className="relative h-full min-h-0 w-full min-w-0 overflow-hidden bg-background">
      <div
        ref={host}
        aria-label={`Terminal ${terminalId}`}
        className="absolute inset-1 left-2 overflow-hidden focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-ring"
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
