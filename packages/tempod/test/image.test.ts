import { describe, expect, test } from "bun:test";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { DEFAULT_TMUX_CONF, DEFAULT_ZSHRC } from "@tempo/protocol";
import { sleep } from "./helpers.ts";

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
});
