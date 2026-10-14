import { describe, expect, it, vi } from "vitest";
import type { WorkspaceCore } from "../../src/do/workspace/core.ts";
import { openTerminal } from "../../src/do/workspace/terminal.ts";
import { waitFor } from "./fakes.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const fixture = () => {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const writes: Uint8Array[] = [];
  const ended = deferred<number>();
  const proc = {
    stdin: new WritableStream<Uint8Array>({
      write: (bytes) => {
        writes.push(bytes);
      },
    }),
    stdout: new ReadableStream<Uint8Array>({
      start: (controller) => {
        output = controller;
      },
    }),
    stderr: null,
    pid: 1,
    isPty: true,
    exitCode: ended.promise,
    output: vi.fn(),
    kill: vi.fn(() => ended.resolve(0)),
    resize: vi.fn(),
  };
  const exec = vi.fn(async () => proc);
  const terminals = new Map();
  const core = {
    terminals,
    container: { exec, running: true },
    touchActivity: vi.fn(),
    scriptEnv: async () => ({}),
    wsOrNull: () => ({ workspaceId: "w1" }),
  } as unknown as WorkspaceCore;
  const open = (waitReady: () => Promise<void> = async () => {}) => {
    const socket = openTerminal(core, "t1", 80, 24, waitReady).webSocket!;
    socket.binaryType = "arraybuffer";
    const messages: Array<string | ArrayBuffer> = [];
    const closed = deferred<number>();
    socket.addEventListener("message", (event) => {
      messages.push(event.data as string | ArrayBuffer);
    });
    socket.addEventListener("close", (event) => closed.resolve(event.code));
    socket.accept();
    return { socket, messages, closed };
  };
  return { core, proc, exec, terminals, writes, output: () => output, ended, open };
};

const ready = async (messages: Array<string | ArrayBuffer>) => {
  await waitFor(() => messages.includes('{"type":"ready"}'));
};

describe("terminal PTY bridge", () => {
  it("bridges ls and Enter to stdin, output to the browser, and resize to the PTY", async () => {
    const f = fixture();
    const { socket, messages, closed } = f.open();
    await ready(messages);
    expect(f.exec).toHaveBeenCalledWith(
      ["tmux", "new-session", "-A", "-s", "t1", "-c", "/workspace"],
      expect.objectContaining({ pty: { cols: 80, rows: 24 }, stdin: "pipe", user: "1000:1000" }),
    );
    socket.send(encoder.encode("ls\r"));
    await waitFor(() => f.writes.length === 1);
    expect(decoder.decode(f.writes[0])).toBe("ls\r");
    f.output().enqueue(encoder.encode("README.md\r\n$ "));
    await waitFor(() => messages.length === 2);
    expect(decoder.decode(messages[1] as ArrayBuffer)).toBe("README.md\r\n$ ");
    socket.send('{"type":"resize","cols":1000,"rows":300}');
    await waitFor(() => f.proc.resize.mock.calls.length === 1);
    expect(f.proc.resize).toHaveBeenCalledWith(500, 200);
    f.output().close();
    f.ended.resolve(0);
    expect(await closed.promise).toBe(1000);
    await waitFor(() => f.terminals.size === 0);
    expect(f.proc.stdin.locked).toBe(false);
    expect(f.proc.stdout.locked).toBe(false);
  });

  it("kills an exec that finishes opening after the browser has disconnected", async () => {
    const f = fixture();
    const opened = deferred<ExecProcess>();
    f.exec.mockImplementation(() => opened.promise as Promise<typeof f.proc>);
    const { socket } = f.open();
    await waitFor(() => f.exec.mock.calls.length === 1);
    socket.close(1000, "panel closed");
    await waitFor(() => f.terminals.size === 0);
    opened.resolve(f.proc);
    await waitFor(() => f.proc.kill.mock.calls.length === 1);
    expect(f.proc.kill).toHaveBeenCalledOnce();
  });

  it("does not start an exec when the panel closes while waiting for the container", async () => {
    const f = fixture();
    const waiting = deferred<void>();
    const { socket } = f.open(() => waiting.promise);
    socket.close(1000, "panel closed");
    await waitFor(() => f.terminals.size === 0);
    waiting.resolve();
    await Promise.resolve();
    expect(f.exec).not.toHaveBeenCalled();
  });

  it("closes with a retryable error when stdin fails instead of silently dropping commands", async () => {
    const f = fixture();
    f.proc.stdin = new WritableStream<Uint8Array>({
      write: () => {
        throw new Error("stdin failed");
      },
    });
    const { socket, messages, closed } = f.open();
    await ready(messages);
    socket.send(encoder.encode("ls\r"));
    expect(await closed.promise).toBe(1011);
    await waitFor(() => f.terminals.size === 0);
    expect(f.proc.kill).toHaveBeenCalledOnce();
  });

  it("never advertises ready if the process has no writable stdin", async () => {
    const f = fixture();
    f.exec.mockResolvedValue({ ...f.proc, stdin: null } as unknown as typeof f.proc);
    const { messages, closed } = f.open();
    expect(await closed.promise).toBe(1011);
    expect(messages).toEqual([]);
    expect(f.proc.kill).toHaveBeenCalledOnce();
  });

  it("cancels output and releases stream locks when the panel closes", async () => {
    const f = fixture();
    const { socket, messages } = f.open();
    await ready(messages);
    socket.close(1000, "panel closed");
    await waitFor(() => f.terminals.size === 0 && !f.proc.stdout.locked && !f.proc.stdin.locked);
    expect(f.proc.kill).toHaveBeenCalledOnce();
  });
});
