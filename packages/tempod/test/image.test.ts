import { describe, expect, test } from "bun:test";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TMUX_CONF, DEFAULT_ZSHRC } from "@tempo/protocol";
import { playwrightServer } from "../src/acp/mcp.ts";
import { sleep } from "./helpers.ts";

type McpParams = {
  protocolVersion?: string;
  capabilities?: Record<string, never>;
  clientInfo?: { name: string; version: string };
  name?: string;
  arguments?: { url: string };
};

type JsonRpcMessage = { jsonrpc: "2.0"; id?: number; method: string; params?: McpParams };

describe.skipIf(process.env["TEMPO_IMAGE_TEST"] !== "1")("workspace image", () => {
  test("runs as tempo with tini as PID 1", () => {
    expect(process.platform).toBe("linux");
    expect(process.getuid?.()).toBe(1000);
    expect(process.getgid?.()).toBe(1000);
    expect(readFileSync("/proc/1/comm", "utf8").trim()).toBe("tini");
  });

  test("contains the agent adapters and workspace tools", () => {
    for (const binary of [
      "claude-agent-acp",
      "codex-acp",
      "opencode",
      "pi",
      "pi-acp",
      "playwright",
      "mcp-server-playwright",
      "git",
      "gh",
      "rg",
      "tmux",
    ])
      expect(Bun.which(binary)).not.toBeNull();

    expect(() => accessSync("/opt/tempo/pi/tempo-profile.ts", constants.R_OK)).not.toThrow();
  });

  test("logs tempo in to zsh with Oh My Zsh and keeps the home defaults", () => {
    expect(Bun.which("zsh")).not.toBeNull();
    expect(() => accessSync("/opt/oh-my-zsh/oh-my-zsh.sh", constants.R_OK)).not.toThrow();
    expect(() => accessSync("/opt/oh-my-zsh", constants.W_OK)).toThrow();

    const passwd = readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .find((l) => l.startsWith("tempo:"));

    expect(passwd?.split(":")[6]).toBe("/bin/zsh");
    expect(readFileSync("/etc/tempo/home-defaults/.zshrc", "utf8")).toBe(DEFAULT_ZSHRC);
    expect(readFileSync("/etc/tempo/home-defaults/.tmux.conf", "utf8")).toBe(DEFAULT_TMUX_CONF);
  });

  test("reaps an orphaned script child after it exits", async () => {
    const parent = Bun.spawn(["bash", "-c", "sleep 0.1 >/dev/null 2>&1 & echo $!"], { stdout: "pipe" });
    const pid = Number((await new Response(parent.stdout).text()).trim());
    expect(pid).toBeGreaterThan(1);
    expect(await parent.exited).toBe(0);

    for (let i = 0; i < 100 && existsSync(`/proc/${pid}`); i++) await sleep(20);
    expect(existsSync(`/proc/${pid}`)).toBe(false);
  });
  test("Playwright MCP finds its Chromium build and loads a page", async () => {
    const server = playwrightServer();
    const cwd = mkdtempSync(join(tmpdir(), "playwright-mcp-"));

    const page = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response("<title>Tempo browser fixture</title><h1>MCP rendered this page</h1>", {
          headers: { "Content-Type": "text/html" },
        }),
    });

    const proc = Bun.spawn([server.command, ...server.args], {
      cwd,
      env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });

    const deadline = setTimeout(() => proc.kill(), 20_000);

    try {
      const send = (message: JsonRpcMessage): void => {
        proc.stdin.write(`${JSON.stringify(message)}\n`);
        proc.stdin.flush();
      };

      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffered = "";

      const reply = async (
        id: number,
      ): Promise<{
        error?: unknown;
        result?: { isError?: boolean; content?: { type: string; text?: string }[] };
      }> => {
        for (;;) {
          const end = buffered.indexOf("\n");

          if (end >= 0) {
            const message = JSON.parse(buffered.slice(0, end));
            buffered = buffered.slice(end + 1);

            if (message.id === id) return message;
            continue;
          }

          const chunk = await reader.read();

          if (chunk.done) throw new Error("Playwright MCP exited before it answered");
          buffered += decoder.decode(chunk.value, { stream: true });
        }
      };

      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "image-test", version: "1" },
        },
      });
      expect((await reply(1)).error).toBeUndefined();
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "browser_navigate", arguments: { url: page.url.href } },
      });

      const navigated = await reply(2);
      const content = navigated.result?.content?.map((block) => block.text ?? "").join("\n");
      expect(navigated.error).toBeUndefined();
      expect(content).toContain("Page Title: Tempo browser fixture");
      expect(navigated.result?.isError).not.toBe(true);

      const snapshot = content?.match(/\[Snapshot\]\((\.playwright-mcp\/[^)]+\.yml)\)/)?.[1];

      if (!snapshot) throw new Error("Playwright MCP did not produce a page snapshot");
      expect(readFileSync(join(cwd, snapshot), "utf8")).toContain('heading "MCP rendered this page"');
    } finally {
      clearTimeout(deadline);
      proc.kill();
      await proc.exited;
      page.stop(true);
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
