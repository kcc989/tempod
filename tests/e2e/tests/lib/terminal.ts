import { Socket } from "./api.ts";
import { nonce, stripAnsi } from "./util.ts";

/** Same CA setup tempod gives its children (01, tempod startup step 2); a terminal shell does not get it. */
const CA_PREAMBLE = [
  "c=/etc/cloudflare/certs/cloudflare-containers-ca.crt",
  'if [ -f "$c" ]; then export NODE_EXTRA_CA_CERTS="$c" SSL_CERT_FILE="$c" GIT_SSL_CAINFO="$c" CURL_CA_BUNDLE="$c" REQUESTS_CA_BUNDLE="$c"; fi',
  "cd /workspace",
].join("\n");

export interface RunResult {
  readonly code: number;
  readonly output: string;
}

/**
 * A terminal channel (01, Terminal): a tmux session in the container, binary keystrokes in,
 * binary screen output back, `{"type":"ready"}` once the PTY runs.
 */
export class Terminal {
  private constructor(
    readonly workspaceId: string,
    readonly terminalId: string,
    readonly socket: Socket,
  ) {}

  /** Opens `/api/ws/terminal/<id>/<t1..t9>` and waits for `ready`. Opening wakes a sleeping workspace. */
  static async open(
    workspaceId: string,
    terminalId = "t9",
    cols = 400,
    rows = 50,
    readyMs = 10 * 60_000,
  ): Promise<Terminal> {
    const socket = await Socket.open(
      `/api/ws/terminal/${workspaceId}/${terminalId}?cols=${cols}&rows=${rows}`,
    );
    await socket.until(
      "terminal ready",
      () => socket.messages.some((m) => (m.data as { type?: unknown } | null)?.type === "ready"),
      readyMs,
    );
    return new Terminal(workspaceId, terminalId, socket);
  }

  /** Everything the terminal printed on this connection, without escape sequences. */
  get screen(): string {
    return stripAnsi(this.socket.output);
  }

  type(text: string): void {
    this.socket.sendBytes(text);
  }

  resize(cols: number, rows: number): void {
    this.socket.sendJson({ type: "resize", cols, rows });
  }

  until<T>(label: string, check: () => T | undefined | null | false, timeoutMs: number): Promise<T> {
    return this.socket.until(label, check, timeoutMs);
  }

  waitFor(text: string, timeoutMs = 60_000): Promise<true> {
    return this.until(`terminal output "${text}"`, () => this.screen.includes(text) || undefined, timeoutMs);
  }

  /**
   * Runs a bash script in /workspace through the interactive shell. The script travels base64
   * encoded and its output comes back base64 encoded between markers, so neither the echoed command
   * line nor tmux redraws can be mistaken for the result. Output is stdout and stderr together,
   * without trailing newlines.
   */
  async run(script: string, timeoutMs = 120_000): Promise<RunResult> {
    const id = nonce();
    const encoded = Buffer.from(`${CA_PREAMBLE}\n${script}\n`).toString("base64");
    this.type(
      `__e2e_out=$(printf %s ${encoded} | base64 -d | bash 2>&1); ` +
        `printf '\\n@@${id}:%s:%s@@\\n' "$?" "$(printf %s "$__e2e_out" | base64 -w0)"\r`,
    );
    const marker = new RegExp(`@@${id}:(\\d+):([A-Za-z0-9+/=\\s]*)@@`);
    const match = await this.until(
      `result of: ${script.split("\n")[0]}`,
      () => marker.exec(this.screen),
      timeoutMs,
    );
    return {
      code: Number(match[1]),
      output: Buffer.from((match[2] ?? "").replace(/\s+/g, ""), "base64").toString("utf8"),
    };
  }

  close(): void {
    this.socket.close();
  }
}

/** Runs one script in a fresh terminal connection and closes it; throws on a non-zero exit. */
export const sh = async (workspaceId: string, script: string, timeoutMs = 120_000): Promise<string> => {
  const term = await Terminal.open(workspaceId);
  try {
    const r = await term.run(script, timeoutMs);
    if (r.code !== 0) throw new Error(`script exited ${r.code}: ${script.split("\n")[0]}\n${r.output}`);
    return r.output;
  } finally {
    term.close();
  }
};

/** Hash of the working tree as a checkpoint computes it (01, Write a checkpoint): own index, `git add -A`. */
export const workingTreeHash = async (workspaceId: string): Promise<string> =>
  (
    await sh(
      workspaceId,
      [
        "export GIT_INDEX_FILE=$(mktemp -u /tmp/e2e-index.XXXXXX)",
        "git read-tree HEAD && git add -A -- . && git write-tree",
        'rm -f "$GIT_INDEX_FILE"',
      ].join("\n"),
    )
  ).trim();

/**
 * Stops the container's main process from inside, as a stand-in for destroying the container:
 * SIGKILL for tempod, or SIGTERM when tempod is PID 1 (the kernel ignores SIGKILL to PID 1 from
 * inside its namespace). The terminal dies with the container, so nothing is awaited.
 */
export const stopContainerFromInside = async (workspaceId: string): Promise<number> => {
  const term = await Terminal.open(workspaceId, "t8");
  const at = Date.now();
  term.type('p=$(pgrep -o -x tempod); if [ "$p" = 1 ]; then kill -TERM 1; else kill -KILL "$p"; fi\r');
  setTimeout(() => term.close(), 5_000);
  return at;
};
