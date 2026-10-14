import { TerminalResize } from "@tempo/protocol";
import { Option, Predicate, Schema } from "effect";
import { errorText, log } from "../../log.ts";
import type { WorkspaceCore } from "./core.ts";

const decodeResize = Schema.decodeUnknownOption(Schema.fromJsonString(TerminalResize));

const READY_WAIT_MS = 5 * 60_000;

export interface TerminalWorkspace {
  readonly terminals: WorkspaceCore["terminals"];
  readonly container: Pick<Container, "exec" | "running"> | null | undefined;
  touchActivity: WorkspaceCore["touchActivity"];
  scriptEnv: WorkspaceCore["scriptEnv"];
  wsOrNull: () => { readonly workspaceId: string } | null;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(n) || min));

/**
 * A terminal is a tmux session opened with a PTY exec (01, Terminal). The socket is accepted
 * without hibernation: hibernation would drop the process handle. Closing the socket kills the
 * exec; tmux keeps the shell and scrollback for the next connection.
 */
export const openTerminal = (
  core: TerminalWorkspace,
  terminalId: string,
  cols: number,
  rows: number,
  waitReady: (deadline: number) => Promise<void>,
): Response => {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.binaryType = "arraybuffer";
  server.accept();

  type TerminalConnection = NonNullable<ReturnType<WorkspaceCore["terminals"]["get"]>>;

  const entry: TerminalConnection = { terminalId, proc: null };
  core.terminals.set(server, entry);
  core.touchActivity();
  let closed = false;
  let writer: WritableStreamDefaultWriter | undefined;
  let reader: ReadableStreamDefaultReader | undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    core.terminals.delete(server);
    void reader?.cancel().catch(() => undefined);
    void writer?.abort().catch(() => undefined);

    try {
      entry.proc?.kill();
    } catch {
      // gone
    }
  };

  server.addEventListener("close", close);
  server.addEventListener("error", close);

  const fail = (e: Parameters<typeof errorText>[0]) => {
    if (closed) return;
    log("warn", "terminal failed", {
      workspaceId: core.wsOrNull()?.workspaceId,
      terminalId,
      error: errorText(e),
    });

    try {
      server.close(1011, core.container?.running ? "terminal failed" : "container not ready");
    } catch {
      // already closed
    }

    close();
  };

  void (async () => {
    try {
      await waitReady(Date.now() + READY_WAIT_MS);

      if (closed) return;
      const env = { TERM: "xterm-256color", HOME: "/home/tempo", ...(await core.scriptEnv()) };

      if (closed) return;

      const proc = await core.container!.exec(
        ["tmux", "new-session", "-A", "-s", terminalId, "-c", "/workspace"],
        {
          pty: { cols: clamp(cols, 10, 500), rows: clamp(rows, 5, 200) },
          stdin: "pipe",
          user: "1000:1000",
          cwd: "/workspace",
          env,
        },
      );

      entry.proc = proc;

      if (closed) {
        proc.kill();

        return;
      }

      if (!proc.stdin || !proc.stdout) throw new Error("terminal streams unavailable");
      writer = proc.stdin.getWriter();
      reader = proc.stdout.getReader();
      server.addEventListener("message", (e) => {
        if (closed) return;

        if (Predicate.isString(e.data)) {
          const r = decodeResize(e.data);

          if (Option.isSome(r)) {
            try {
              proc.resize(clamp(r.value.cols, 10, 500), clamp(r.value.rows, 5, 200));
            } catch (e) {
              fail(e);
            }
          }

          return;
        }

        const data = new Uint8Array(e.data);
        void writer!.write(data).catch(fail);
        core.touchActivity();
      });
      server.send(JSON.stringify({ type: "ready" }));
      {
        for (;;) {
          const { value, done } = await reader.read();

          if (done || closed) break;

          if (!(value instanceof Uint8Array)) throw new Error("Expected terminal stdout bytes");
          server.send(value);
        }
      }

      if (closed) return;
      await proc.exitCode.catch(() => undefined);

      try {
        server.close(1000, "terminal exited");
      } catch {
        // already closed
      }

      close();
    } catch (e) {
      fail(e);
    } finally {
      reader?.releaseLock();
      writer?.releaseLock();
    }
  })();

  return new Response(null, { status: 101, webSocket: client });
};
