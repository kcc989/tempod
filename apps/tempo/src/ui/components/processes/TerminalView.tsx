import { Schema, Match } from "effect";
import { reconnectDelay } from "@tempo/protocol";
import type { ITerminalOptions } from "@xterm/xterm";
import { createContext, useContext, useEffect, useRef, useState } from "react";
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

/** The operations this view needs from the lazily loaded terminal. */
export interface TerminalSurface {
  readonly cols: number;
  readonly rows: number;
  readonly options: ITerminalOptions;
  focus(): void;
  dispose(): void;
  reset(): void;
  write(data: Uint8Array): void;
  onData(listener: (data: string) => void): void;
  onBinary(listener: (data: string) => void): void;
  onResize(listener: (size: { cols: number; rows: number }) => void): void;
}

export type OpenTerminal = (
  host: HTMLElement,
  options: ITerminalOptions,
) => Promise<{ terminal: TerminalSurface; fit(): boolean }>;

const openTerminal: OpenTerminal = async (host, options) => {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/xterm/css/xterm.css"),
  ]);

  const terminal = new Terminal(options);
  const addon = new FitAddon();
  terminal.loadAddon(addon);
  terminal.open(host);

  return {
    terminal,
    fit: () => {
      const dimensions = addon.proposeDimensions();

      if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return false;
      const size = terminalSize(dimensions.cols, dimensions.rows);
      terminal.resize(size.cols, size.rows);

      return true;
    },
  };
};

export const TerminalRuntimeContext = createContext(openTerminal);

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
  const open = useContext(TerminalRuntimeContext);
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<TerminalSurface | null>(null);
  const fitTerminal = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [generation, setGeneration] = useState(0);
  const { resolved } = useTheme();

  useEffect(() => {
    const el = host.current;

    if (!el) return;
    let disposed = false;
    let t: TerminalSurface | null = null;
    let fit: (() => boolean) | null = null;
    let ws: WebSocket | null = null;
    let ready = false;
    let attempts = 0;
    let connections = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: ResizeObserver | null = null;
    let reconnectAllowed = true;
    let fitFrame: number | null = null;
    let started = false;
    setStatus("loading");

    const send = (data: Uint8Array | string) => {
      if (ws && ready && ws.readyState === WebSocket.OPEN) ws.send(data);
    };

    const safeFit = () => {
      if (!fit || el.clientWidth === 0 || el.clientHeight === 0) return false;

      try {
        return fit();
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
      sock.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
        if (ws !== sock || !t) return;

        if (Schema.is(Schema.String)(e.data)) {
          if (ready || !isReadyFrame(e.data)) return;

          if (connections > 0) t.write(new Uint8Array([27, 99]));
          connections++;
          attempts = 0;
          ready = true;
          t.options.disableStdin = false;

          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = null;
          setStatus("ready");
          sock.send(resizeFrame(t.cols, t.rows));

          return;
        }

        if (ready && e.data instanceof ArrayBuffer) t.write(new Uint8Array(e.data));
      };

      sock.onclose = (e: CloseEvent) => {
        if (ws !== sock || disposed) return;
        ws = null;
        ready = false;

        if (t) t.options.disableStdin = true;

        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = null;
        const action = terminalCloseAction(e.code);

        if (action !== "reconnect") {
          reconnectAllowed = false;

          return setStatus(action);
        }

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

    const reconnectNow = () => {
      if (disposed || !t || !reconnectAllowed) return;

      if (!started) {
        scheduleFit();

        return;
      }

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
      const loaded = await open(el, {
        fontFamily: terminalFont(),
        fontSize: 12,
        cursorBlink: true,
        disableStdin: true,
        scrollback: 5000,
        theme: terminalTheme(),
      });

      if (disposed) {
        loaded.terminal.dispose();

        return;
      }

      t = loaded.terminal;
      fit = loaded.fit;
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
      window.removeEventListener("online", reconnectNow);
      document.removeEventListener("visibilitychange", onVisible);

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
  }, [workspaceId, terminalId, generation, open]);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (term.current) term.current.options.theme = terminalTheme();
    });

    return () => cancelAnimationFrame(id);
  }, [resolved]);
  useEffect(() => {
    if (!active) return;
    fitTerminal.current?.();

    if (status !== "ready") return;
    const frame = requestAnimationFrame(() => term.current?.focus());

    return () => cancelAnimationFrame(frame);
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
          <span>{status === "failed" ? "The terminal could not load." : TERMINAL_CLOSE_TEXT[status]}</span>
          {Match.value(status).pipe(
            Match.when("badVersion", () => (
              <Button size="sm" variant="outline" onClick={() => globalThis.location?.reload()}>
                Reload
              </Button>
            )),
            Match.when("notFound", () => null),
            Match.orElse(() => (
              <Button size="sm" variant="outline" onClick={() => setGeneration((g) => g + 1)}>
                {status === "exited" ? "Start a new shell" : "Reconnect"}
              </Button>
            )),
          )}
        </div>
      )}
    </div>
  );
}
