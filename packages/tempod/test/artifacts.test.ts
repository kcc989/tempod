import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACT_MESSAGES } from "@tempo/protocol";
import { handleMcpMessage, TOOLS } from "../src/tempo-mcp.ts";
import { cleanupDirs, DoClient, startTempod, tmpDir, type Harness } from "./helpers.ts";

afterAll(cleanupDirs);

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const viaSocket = (path: string) => (p: string, init?: RequestInit) =>
  fetch(`http://tempod${p}`, { ...init, unix: path } as RequestInit);

const boot = async () => {
  h = startTempod();
  const client = new DoClient(h.base);
  await client.hello();
  await client.waitFor(() => existsSync(h!.app.config.mcpSocket), 5000, "mcp socket");
  const call = viaSocket(h.app.config.mcpSocket);
  let id = 0;
  const publish = async (args: Record<string, unknown>, sessionId = "01session") =>
    (
      (await handleMcpMessage(
        {
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params: { name: "publish_artifact", arguments: args },
        },
        call,
        sessionId,
      )) as { result: { content: Array<{ type?: string; text: string }>; isError?: boolean } }
    ).result;
  return { client, publish, ws: h.config.workspace, dir: h.config.artifactsDir, config: h.config };
};

describe("publish_artifact (01, Artifacts)", () => {
  test("tools/list has the tool with the spec's description", () => {
    const tool = TOOLS.find((t) => t.name === "publish_artifact")!;
    expect(tool.description).toStartWith("Show a file to the user in Tempo.");
    expect(tool.inputSchema.required).toEqual(["path", "title"]);
  });

  test("copies the file, emits artifact.published, and a second publish of the same path is version 2", async () => {
    const { client, publish, ws, config } = await boot();
    writeFileSync(join(ws, "Plan.MD"), "# Plan\n");
    const first = await publish({ path: join(ws, "Plan.MD"), title: "Plan", summary: "Steps" });
    expect(first).toEqual({
      content: [{ type: "text", text: 'Published "Plan" as version 1. The user can open it in Tempo.' }],
    });
    const e1 = await client.waitEvent("artifact.published");
    expect(e1).toMatchObject({
      sessionId: "01session",
      turnId: null,
      version: 1,
      path: join(ws, "Plan.MD"),
      name: "Plan.MD",
      title: "Plan",
      summary: "Steps",
      mime: "text/markdown",
      artifactKind: "markdown",
      size: 7,
      sha256: createHash("sha256").update("# Plan\n").digest("hex"),
    });
    expect(e1.stagedPath).toBe(join(config.artifactsStage, e1.artifactId, "1"));
    expect(readFileSync(e1.stagedPath, "utf8")).toBe("# Plan\n");

    writeFileSync(join(ws, "Plan.MD"), "# Plan v2\n");
    expect((await publish({ path: join(ws, "Plan.MD"), title: "Plan" })).content[0]!.text).toContain(
      "version 2",
    );
    const e2 = await client.waitEvent("artifact.published", (e) => e.version === 2);
    expect(e2.artifactId).toBe(e1.artifactId);
    expect(e2.summary).toBeUndefined();
    expect(readFileSync(e1.stagedPath, "utf8")).toBe("# Plan\n");

    // Another session publishing the same path gets its own artifact.
    await publish({ path: join(ws, "Plan.MD"), title: "Plan" }, "01other");
    const e3 = await client.waitEvent("artifact.published", (e) => e.sessionId === "01other");
    expect(e3.artifactId).not.toBe(e1.artifactId);
    expect(e3.version).toBe(1);

    await client.ok("artifact.release", { artifactId: e1.artifactId, version: 1 });
    expect(existsSync(e1.stagedPath)).toBe(false);
    expect(existsSync(e2.stagedPath)).toBe(true);
    await client.ok("artifact.release", { artifactId: e1.artifactId, version: 1 });
    await client.ok("artifact.release", { artifactId: e1.artifactId, version: 2 });
    expect(existsSync(join(config.artifactsStage, e1.artifactId))).toBe(false);
    client.close();
  });

  test("files in TEMPO_ARTIFACTS_DIR publish; paths outside, symlinks out, folders, bad types and big files fail", async () => {
    const { client, publish, ws, dir } = await boot();
    writeFileSync(join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect((await publish({ path: join(dir, "shot.png"), title: "Shot" })).isError).toBeUndefined();
    expect((await client.waitEvent("artifact.published")).artifactKind).toBe("image");

    const outside = join(tmpDir(), "secret.md");
    writeFileSync(outside, "x");
    symlinkSync(outside, join(ws, "link.md"));
    mkdirSync(join(ws, "folder.md"));
    const refused = async (args: Record<string, unknown>, text: string) => {
      const r = await publish(args);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toBe(text);
    };
    await refused({ path: outside, title: "x" }, ARTIFACT_MESSAGES.path);
    await refused({ path: join(ws, "link.md"), title: "x" }, ARTIFACT_MESSAGES.path);
    await refused({ path: join(ws, "folder.md"), title: "x" }, ARTIFACT_MESSAGES.path);
    await refused({ path: "relative.md", title: "x" }, ARTIFACT_MESSAGES.path);
    await refused({ path: join(ws, "missing.md"), title: "x" }, ARTIFACT_MESSAGES.path);
    writeFileSync(join(ws, "app.exe"), "x");
    await refused({ path: join(ws, "app.exe"), title: "x" }, ARTIFACT_MESSAGES.type);
    writeFileSync(join(ws, "big.txt"), "");
    truncateSync(join(ws, "big.txt"), 25 * 1024 * 1024 + 1);
    await refused({ path: join(ws, "big.txt"), title: "x" }, ARTIFACT_MESSAGES.size);

    const noTitle = await publish({ path: join(dir, "shot.png"), title: "" });
    expect(noTitle.isError).toBe(true);
    const longSummary = await publish({ path: join(dir, "shot.png"), title: "x", summary: "s".repeat(501) });
    expect(longSummary.isError).toBe(true);
    expect(client.of("artifact.published")).toHaveLength(1);
    client.close();
  });
});
