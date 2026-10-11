import type {
  AgentId,
  PermissionRequest,
  Project,
  SettingsLayer,
  Turn,
  WorkspaceDetail,
  WorkspaceState,
  WorkspaceSummary,
} from "@tempo/protocol";
import { closeAllSockets, rpc, RpcError, rpcRetry } from "./api.ts";
import { isEnded, WorkspaceWatch } from "./channels.ts";
import { E2E, required } from "./env.ts";
import { waitFor } from "./util.ts";

/** Shared steps: the test project, workspaces that clean up after themselves, prompts, settings. */

export const testProject = async (): Promise<Project> => {
  const id = E2E.projectId || required("TEMPO_E2E_PROJECT_ID");
  const project = (await rpc("listProjects", {})).find((p) => p.id === id);
  if (!project) throw new Error(`TEMPO_E2E_PROJECT_ID ${id} is not a linked project`);
  return project;
};

const perTest = new Set<string>();
const perFile = new Set<string>();

export interface NewWorkspace {
  readonly summary: WorkspaceSummary;
  readonly watch: WorkspaceWatch;
  /** Just before createWorkspace was called. */
  readonly startedAt: number;
}

/**
 * createWorkspace on the test project (source `new` from its default branch), then opens the
 * workspace channel. The workspace is archived and deleted after the test (or the file, for
 * `scope: "file"`), unless TEMPO_E2E_KEEP=1.
 */
export const newWorkspace = async (
  opts: { prompt?: string; agent?: AgentId; scope?: "test" | "file" } = {},
): Promise<NewWorkspace> => {
  const project = await testProject();
  const startedAt = Date.now();
  const summary = await rpc("createWorkspace", {
    projectId: project.id,
    source: { kind: "new", baseBranch: project.defaultBranch },
    ...(opts.agent ? { agent: opts.agent } : {}),
    ...(opts.prompt ? { prompt: { text: opts.prompt } } : {}),
  });
  (opts.scope === "file" ? perFile : perTest).add(summary.id);
  const watch = await WorkspaceWatch.open(summary.id);
  return { summary, watch, startedAt };
};

export const getState = async (workspaceId: string): Promise<WorkspaceDetail> =>
  rpc("getWorkspace", { workspaceId });

/** Polls getWorkspace; for lifecycle steps during which a channel may be closed (archive, restore). */
export const pollState = (
  workspaceId: string,
  states: ReadonlyArray<WorkspaceState>,
  timeoutMs: number,
): Promise<WorkspaceDetail> =>
  waitFor(
    `workspace ${workspaceId} state ${states.join(" or ")}`,
    async () => {
      const d = await getState(workspaceId);
      if (d.state === "error" && !states.includes("error")) {
        throw new Error(
          `workspace ${workspaceId} went to error: ${d.errorCode ?? ""} ${d.errorDetail ?? ""}`,
        );
      }
      return states.includes(d.state) ? d : undefined;
    },
    timeoutMs,
  );

const dispose = async (workspaceId: string): Promise<void> => {
  const detail = await getState(workspaceId).catch(() => null);
  if (!detail) return;
  if (detail.state !== "archived") {
    await rpcRetry("archiveWorkspace", { workspaceId }, 10 * 60_000, ["WORKSPACE_BUSY"]);
    await pollState(workspaceId, ["archived"], 15 * 60_000);
  }
  await rpc("deleteWorkspace", { workspaceId });
};

const disposeAll = async (ids: Set<string>): Promise<void> => {
  const list = [...ids];
  ids.clear();
  if (E2E.keep) return;
  await Promise.all(
    list.map((id) =>
      dispose(id).catch((e: unknown) => {
        console.warn(
          `cleanup: workspace ${id} was not deleted: ${e instanceof Error ? e.message : String(e)}`,
        );
      }),
    ),
  );
};

/** For test.afterEach: closes sockets and removes the workspaces the test created. */
export const cleanupTest = async (): Promise<void> => {
  closeAllSockets();
  await disposeAll(perTest);
};

/** For test.afterAll. */
export const cleanupFile = async (): Promise<void> => {
  closeAllSockets();
  await disposeAll(perTest);
  await disposeAll(perFile);
};

export const firstTurn = (watch: WorkspaceWatch): Turn => {
  const turn = [...watch.turns.values()].sort((a, b) => a.seq - b.seq)[0];
  if (!turn) throw new Error("the workspace has no turn; was it created with a prompt?");
  return turn;
};

export const sendPrompt = (
  watch: WorkspaceWatch,
  sessionId: string,
  text: string,
  extra: { reviewCommentIds?: string[]; attachmentIds?: string[]; mentions?: Array<{ path: string }> } = {},
): Promise<Turn> =>
  rpc("sendPrompt", {
    workspaceId: watch.workspaceId,
    sessionId,
    text,
    mentions: extra.mentions ?? [],
    attachmentIds: extra.attachmentIds ?? [],
    reviewCommentIds: extra.reviewCommentIds ?? [],
  });

/** Sends a prompt and waits for its turn to end. */
export const promptAndWait = async (
  watch: WorkspaceWatch,
  sessionId: string,
  text: string,
  timeoutMs = 10 * 60_000,
  extra: Parameters<typeof sendPrompt>[3] = {},
): Promise<Turn> => {
  const turn = await sendPrompt(watch, sessionId, text, extra);
  return watch.waitTurnEnded(turn.id, timeoutMs);
};

/** Waits until the turn's checkpoint id is set; it is written after turn.ended (03, step 2). */
export const turnCheckpoint = (
  watch: WorkspaceWatch,
  turnId: string,
  timeoutMs = 3 * 60_000,
): Promise<string> =>
  watch.until(
    `checkpoint of turn ${turnId}`,
    () => watch.turns.get(turnId)?.checkpointId ?? undefined,
    timeoutMs,
  );

/** Waits for a ready workspace, then starts a session in it. */
export const readySession = async (
  watch: WorkspaceWatch,
  agent: AgentId = "claude",
  extra: { modeId?: string; model?: string } = {},
): Promise<string> => {
  await watch.waitState(["ready"], 15 * 60_000);
  const session = await rpc("createSession", { workspaceId: watch.workspaceId, agent, ...extra });
  return session.id;
};

/**
 * Answers every permission request of a turn with `choose` until the turn ends. Returns the
 * requests it answered.
 */
export const answerPermissionsUntilEnd = async (
  watch: WorkspaceWatch,
  turnId: string,
  choose: (req: PermissionRequest) => Promise<void>,
  timeoutMs = 15 * 60_000,
): Promise<{ turn: Turn; answered: PermissionRequest[] }> => {
  const answered: PermissionRequest[] = [];
  const done = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const next = await watch.until(
      `permission request or end of turn ${turnId}`,
      () => {
        const t = watch.turns.get(turnId);
        if (t && isEnded(t)) return { kind: "ended" as const, turn: t };
        const req = watch.pendingPermissions().find((p) => p.turnId === turnId && !done.has(p.requestId));
        return req ? { kind: "request" as const, req } : undefined;
      },
      Math.max(1_000, deadline - Date.now()),
    );
    if (next.kind === "ended") return { turn: next.turn, answered };
    done.add(next.req.requestId);
    answered.push(next.req);
    await choose(next.req);
  }
};

export const allowOption = (req: PermissionRequest): { optionId: string; name: string } => {
  const option = req.options.find((o) => o.kind.startsWith("allow"));
  if (!option)
    throw new Error(
      `permission request ${req.requestId} has no allow option: ${JSON.stringify(req.options)}`,
    );
  return option;
};

type Layer = Record<string, unknown>;

const mergeLayer = (base: Layer, patch: Layer): Layer => {
  const out: Layer = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const prev = out[k];
    out[k] =
      typeof v === "object" && v !== null && !Array.isArray(v) && typeof prev === "object" && prev !== null
        ? mergeLayer(prev as Layer, v as Layer)
        : v;
  }
  return out;
};

/** Overrides project settings (precedence 1 in 01) and returns a function that restores them. */
export const withProjectSettings = async (patch: SettingsLayer): Promise<() => Promise<void>> => {
  const project = await testProject();
  const before = project.settings;
  const settings = mergeLayer(before as Layer, patch as Layer) as SettingsLayer;
  await rpc("updateProjectSettings", { projectId: project.id, settings });
  return async () => {
    await rpc("updateProjectSettings", { projectId: project.id, settings: before });
  };
};

export const isRpcError = (e: unknown, code: string): boolean => e instanceof RpcError && e.code === code;
