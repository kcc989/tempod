import { Schema } from "effect";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";
import { ProofContent, newId, unwrap, type ToolRes } from "@tempo/protocol";
import { PROOF_TEXT, globMatches } from "../../src/do/workspace/proof.ts";
import { emitEvent, sqlRows, waitApplied, waitFor } from "./fakes.ts";
import { seedReadyWorkspace } from "./ready-fixture.ts";

const PROFILE = `version: 1
checks:
  - name: typecheck
    command: bun run typecheck
    timeout_minutes: 5
screens:
  - route: /todos
    files: ["src/routes/todos/**"]
  - route: /settings
    files: ["src/routes/settings.tsx"]
`;

const setup = async () => {
  const w = await seedReadyWorkspace({ credentials: ["claude"] });

  unwrap(await env.APP_DEPLOY.getByName(w.seeded.projectId).updateProfile({ source: PROFILE, revision: 0 }));
  w.tempod.on("git.changes", () => ({
    files: [{ path: "src/routes/todos/index.tsx", status: "M", additions: 3, deletions: 1 }],
    baseSha: "c".repeat(40),
    headSha: "d".repeat(40),
  }));
  const session = unwrap(await w.stub.createSession({ agent: "claude" }));

  const publish = async (name: string) => {
    const artifactId = newId();

    await env.DATA.put(`artifacts/${w.workspaceId}/${artifactId}/1/${name}`, "png");
    await waitApplied(
      w.stub,
      await emitEvent(w.stub, w.tempod, {
        kind: "artifact.published",
        sessionId: session.id,
        turnId: null,
        artifactId,
        version: 1,
        path: `/workspace/${name}`,
        name,
        title: name,
        mime: "image/png",
        artifactKind: "image",
        size: 3,
        sha256: "0".repeat(64),
        stagedPath: `/home/tempo/.tempod/artifacts/${artifactId}/1`,
      }),
    );

    return artifactId;
  };

  const submit = (params: Schema.Json) =>
    runInDurableObject(w.stub, () => w.tempod.tool({ op: "submit_proof", sessionId: session.id, params }));

  const exit = async (runId: string, exitCode: number) =>
    waitApplied(
      w.stub,
      await emitEvent(w.stub, w.tempod, {
        kind: "script.exited",
        runId,
        exitCode,
        signal: null,
        timedOut: false,
      }),
    );

  const proofs = async () =>
    (
      await sqlRows(w.stub, "SELECT status, content_json FROM items WHERE kind = 'proof' ORDER BY created_at")
    ).map((r) => ({
      status: r["status"],
      content: Schema.decodeUnknownSync(ProofContent)(JSON.parse(String(r["content_json"]))),
    }));

  const userMessage = async (text: string) => {
    unwrap(
      await w.stub.sendPrompt({
        sessionId: session.id,
        text,
        mentions: [],
        attachmentIds: [],
        reviewCommentIds: [],
      }),
    );
    await waitFor(
      async () => (await sqlRows(w.stub, "SELECT id FROM items WHERE kind = 'user_message'")).length > 0,
    );

    const [row] = await sqlRows(
      w.stub,
      "SELECT id FROM items WHERE kind = 'user_message' ORDER BY created_at DESC",
    );

    return String(row!["id"]);
  };

  return { ...w, sid: session.id, publish, submit, exit, proofs, userMessage };
};

const text = (reply: ToolRes) => (reply.ok ? reply.result : `error: ${reply.error.message}`);

describe("proof and checklist (13, L-ADR-2)", { timeout: 30_000 }, () => {
  it("matches globs within and across path segments", ({ expect }) => {
    expect(globMatches("src/routes/todos/**", "src/routes/todos/a/b.tsx")).toBe(true);
    expect(globMatches("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatches("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(globMatches("**/*.css", "app.css")).toBe(true);
    expect(globMatches("src/routes/settings.tsx", "src/routes/settingsXtsx")).toBe(false);
  });

  it("refuses bad input, runs the profile's checks, and is complete only when every check passes and every changed route has a screen", async ({
    expect,
  }) => {
    const w = await setup();

    expect(text(await w.submit({ summary: "a\nb\nc\nd\ne\nf", screens: [], checklist: [] }))).toBe(
      `error: ${PROOF_TEXT.tooLong}`,
    );
    expect(
      text(
        await w.submit({
          summary: "Due dates",
          screens: [{ route: "/todos", viewport: "desktop", theme: "light", image: "todos.png" }],
          checklist: [],
        }),
      ),
    ).toBe(`error: ${PROOF_TEXT.publishFirst("todos.png")}`);
    expect(
      text(await w.submit({ summary: "Due dates", screens: [], checklist: [{ itemId: "x", note: "" }] })),
    ).toBe(`error: ${PROOF_TEXT.unknownItem("x")}`);

    expect(text(await w.submit({ summary: "Due dates", screens: [], checklist: [] }))).toBe(
      PROOF_TEXT.answer,
    );
    const [start] = w.tempod.requestsOf("script.start");
    expect(start).toMatchObject({
      kind: "run",
      scriptId: "check:typecheck",
      cwd: "/workspace",
      timeoutMs: 300_000,
    });
    expect((await w.proofs())[0]).toMatchObject({
      status: "in_progress",
      content: {
        status: "checking",
        missingRoutes: ["/todos"],
        checks: [{ name: "typecheck", status: "running" }],
      },
    });
    await w.exit(start.runId, 0);
    expect((await w.proofs())[0]).toMatchObject({
      status: "completed",
      content: { status: "incomplete", checks: [{ status: "passed", exitCode: 0 }] },
    });

    const image = await w.publish("todos.png");
    const screen = { route: "/todos", viewport: "phone", theme: "dark", image: "/workspace/todos.png" };
    expect(text(await w.submit({ summary: "Due dates", screens: [screen], checklist: [] }))).toBe(
      PROOF_TEXT.answer,
    );
    const second = w.tempod.requestsOf("script.start")[1];
    await w.exit(second.runId, 1);
    expect((await w.proofs())[1]?.content).toMatchObject({
      status: "incomplete",
      missingRoutes: [],
      screens: [{ route: "/todos", artifactId: image, version: 1 }],
      checks: [{ status: "failed", exitCode: 1 }],
    });

    await w.submit({ summary: "Due dates", screens: [{ ...screen, image: "todos.png" }], checklist: [] });
    await w.exit(w.tempod.requestsOf("script.start")[2].runId, 0);
    expect((await w.proofs())[2]?.content.status).toBe("complete");

    const events = await sqlRows(
      w.stub,
      "SELECT payload_json FROM lifecycle_events WHERE type = 'loop.proof.submitted' ORDER BY seq",
    );

    expect(events.map((e) => JSON.parse(String(e["payload_json"])).complete)).toEqual([false, false, true]);
  });

  it("adds a user message to the checklist, asks each prompt to resolve it, resolves it by a complete proof and reopens it", async ({
    expect,
  }) => {
    const w = await setup();
    const itemId = await w.userMessage("/go The date picker should use the theme's input style.");
    const item = unwrap(await w.stub.addChecklistItem({ itemId }));
    expect(unwrap(await w.stub.addChecklistItem({ itemId })).id).toBe(item.id);
    expect(unwrap(await w.stub.getWorkspace({})).checklist).toEqual([
      expect.objectContaining({ id: item.id, status: "open", sourceItemId: itemId }),
    ]);

    await waitFor(() => w.tempod.requestsOf("session.prompt").length > 0);
    const [first] = w.tempod.requestsOf("session.prompt");
    await waitApplied(
      w.stub,
      await emitEvent(w.stub, w.tempod, {
        kind: "turn.ended",
        sessionId: w.sid,
        turnId: first.turnId,
        stopReason: "end_turn",
      }),
    );
    unwrap(
      await w.stub.sendPrompt({
        sessionId: w.sid,
        text: "Go on",
        mentions: [],
        attachmentIds: [],
        reviewCommentIds: [],
      }),
    );
    await waitFor(() =>
      w.tempod
        .requestsOf("session.prompt")
        .some((p) =>
          p.content.some(
            (c: { text?: string }) => c.text === `${PROOF_TEXT.checklistHeader}\n${item.id}: ${item.text}`,
          ),
        ),
    );

    await w.publish("todos.png");
    expect(
      text(
        await w.submit({
          summary: "Picker",
          screens: [{ route: "/todos", viewport: "desktop", theme: "light", image: "todos.png" }],
          checklist: [],
        }),
      ),
    ).toBe(PROOF_TEXT.answer);
    await w.exit(w.tempod.requestsOf("script.start")[0].runId, 0);
    expect((await w.proofs())[0]?.content).toMatchObject({
      status: "incomplete",
      missingChecklist: [item.id],
    });

    await w.submit({
      summary: "Picker",
      screens: [{ route: "/todos", viewport: "desktop", theme: "light", image: "todos.png" }],
      checklist: [{ itemId: item.id, note: "Uses the input style." }],
    });
    await w.exit(w.tempod.requestsOf("script.start")[1].runId, 0);
    const [resolved] = unwrap(await w.stub.getWorkspace({})).checklist ?? [];
    expect(resolved).toMatchObject({
      status: "resolved",
      resolvedBy: (await w.proofs())[1]?.content.proofId,
    });

    unwrap(await w.stub.reopenChecklistItem({ checklistId: item.id }));
    unwrap(await w.stub.reopenChecklistItem({ checklistId: item.id }));
    expect(unwrap(await w.stub.getWorkspace({})).checklist?.[0]).toMatchObject({
      status: "open",
      resolvedBy: null,
    });

    const events = await sqlRows(
      w.stub,
      "SELECT type FROM lifecycle_events WHERE type LIKE 'loop.checklist.%' ORDER BY seq",
    );

    expect(events.map((e) => e["type"])).toEqual(["loop.checklist.added", "loop.checklist.reopened"]);
  });
});
