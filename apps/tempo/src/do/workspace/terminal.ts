import { TerminalResize } from "@tempo/protocol";
import { Schema } from "effect";
import { errorText, log } from "../../log.ts";
import { containerRunning } from "./container.ts";
import type { WorkspaceCore } from "./core.ts";

const decodeResize = Schema.decodeUnknownOption(Schema.fromJsonString(TerminalResize));
const READY_WAIT_MS = 5 * 60_000;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(n) || min));

/**
 * A terminal is a tmux session opened with a PTY exec (01, Terminal). The socket is accepted
 * without hibernation: hibernation would drop the process handle. Closing the socket kills the
 * exec; tmux keeps the shell and scrollback for the next connection.
 */
export const openTerminal = (
  core: WorkspaceCore,
  terminalId: string,
  cols: number,
  rows: number,
  waitReady: (deadline: number) => Promise<void>,
): Response => {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  const entry: { terminalId: string; proc: ExecProcess | null } = { terminalId, proc: null };
  core.terminals.set(server, entry);
  core.touchActivity();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    core.terminals.delete(server);
    try {
      entry.proc?.kill();
    } catch {
      // gone
    }
  };
  server.addEventListener("close", close);
  server.addEventListener("error", close);

  void (async () => {
    try {
      await waitReady(Date.now() + READY_WAIT_MS);
      if (closed) return;
      const env = { TERM: "xterm-256color", HOME: "/home/tempo", ...(await core.scriptEnv()) };
      const proc = await core.container!.exec(["tmux", "new-session", "-A", "-s", terminalId, "-c", "/workspace"], {
        pty: { cols: clamp(cols, 10, 500), rows: clamp(rows, 5, 200) },
        stdin: "pipe",
        user: "1000:1000",
        cwd: "/workspace",
        env,
      });
      entry.proc = proc;
      if (closed) return close();
      const writer = proc.stdin?.getWriter();
      server.addEventListener("message", (e) => {
        if (typeof e.data === "string") {
          const r = decodeResize(e.data);
          if (r._tag === "Some") proc.resize(clamp(r.value.cols, 10, 500), clamp(r.value.rows, 5, 200));
          return;
        }
        const data = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : (e.data as Uint8Array);
        void writer?.write(data).catch(() => close());
        core.touchActivity();
      });
      server.send(JSON.stringify({ type: "ready" }));
      const reader = proc.stdout?.getReader();
      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || closed) break;
          server.send(value as Uint8Array);
        }
      }
      await proc.exitCode.catch(() => undefined);
      try {
        server.close(1000, "terminal exited");
      } catch {
        // already closed
      }
      close();
    } catch (e) {
      log("warn", "terminal failed", { workspaceId: core.wsOrNull()?.workspaceId, terminalId, error: errorText(e) });
      try {
        server.close(1011, containerRunning(core) ? "terminal failed" : "container not ready");
      } catch {
        // already closed
      }
      close();
    }
  })();

  return new Response(null, { status: 101, webSocket: client });
};
