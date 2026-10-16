import { Schema } from "effect";
import {
  AGENT_IDS,
  DEFAULT_SETTINGS,
  TempoError,
  flattenConfigOptions,
  modelOption,
  newId,
  randomToken,
  type AgentId,
  type FnOutput,
} from "@tempo/protocol";
import { SECRET_KEYS } from "../credential.ts";
import type { WorkspaceCore } from "./core.ts";
import { waitHealthy } from "./container.ts";
import { agentEnv } from "./queue.ts";
import { TempodClient, openTempodSocket } from "./tempod-client.ts";

const LIFETIME_MS = 10 * 60_000;

type Catalog = { signature: string; models: FnOutput<"listModels"> };

const PROVIDERS: Record<AgentId, readonly string[]> = {
  claude: [SECRET_KEYS.claude, SECRET_KEYS.anthropic],
  codex: [SECRET_KEYS.codex, SECRET_KEYS.openai],
  opencode: [SECRET_KEYS.openrouter],
  pi: [SECRET_KEYS.openrouter],
};

const catalogKey = async (core: WorkspaceCore) => {
  const status = await core.credentials().status();
  const keys = new Set(status.map((entry) => entry.key));
  const agents = AGENT_IDS.filter((agent) => PROVIDERS[agent].some((key) => keys.has(key)));
  const agentStatus = status.filter((entry) => Object.values(SECRET_KEYS).some((key) => key === entry.key));
  const signature = () => JSON.stringify([core.container?.images["workspace"], agentStatus]);

  return { agents, agentStatus, signature };
};

/**
 * The stored catalog, read without a container. Null when an agent with a login has no stored
 * models yet. `current` is false when credential metadata or the image changed since discovery.
 */
export const storedModels = async (
  core: WorkspaceCore,
  userId: string,
): Promise<{ models: FnOutput<"listModels">; current: boolean } | null> => {
  if (core.ctx.id.name !== `models:${userId}` || core.wsOrNull()) throw new TempoError("NOT_FOUND");
  core.setKv("catalogUserId", userId);
  const { agents, signature } = await catalogKey(core);

  if (!agents.length) return { models: [], current: true };
  const cached = core.kv<Catalog>("catalogModels");

  if (!cached) return null;
  const models = cached.models.filter((entry) => agents.includes(entry.agent));

  if (models.length !== agents.length) return null;

  return { models, current: cached.signature === signature() };
};

export const discoverModels = async (
  core: WorkspaceCore,
  userId: string,
): Promise<FnOutput<"listModels">> => {
  if (core.ctx.id.name !== `models:${userId}` || core.wsOrNull()) throw new TempoError("NOT_FOUND");
  core.setKv("catalogUserId", userId);
  const credentials = core.credentials();
  const { agents, agentStatus, signature: cacheSignature } = await catalogKey(core);

  if (!agents.length) return [];
  const container = core.container;

  if (!container) throw new TempoError("CONTAINER_START_FAILED");
  const cached = core.kv<Catalog>("catalogModels");

  if (cached?.signature === cacheSignature()) return cached.models;

  core.setKv("catalogToken", randomToken(32));
  await core.ctx.storage.setAlarm(Date.now() + LIFETIME_MS);
  let client: TempodClient | null = null;

  try {
    if (container.running) await container.destroy();
    container.start({
      image: container.images["workspace"] ?? "workspace",
      instance: DEFAULT_SETTINGS.environment.instance,
      enableInternet: false,
      env: {
        TEMPOD_TOKEN: core.kv<string>("catalogToken")!,
        TEMPOD_PORT: "7070",
        TEMPO_WORKSPACE_ID: core.workspaceId,
      },
      labels: { purpose: "model-discovery" },
    });

    const outbound = core.ctx.exports.TempoOutbound({
      props: { workspaceId: core.workspaceId, userId, catalog: true },
    });

    await container.interceptAllOutboundHttp(outbound);
    await container.interceptOutboundHttps("*", outbound);
    await container.setInactivityTimeout(LIFETIME_MS);
    await waitHealthy(core, new AbortController().signal);
    client = new TempodClient(
      core,
      await openTempodSocket(core),
      () => undefined,
      () => undefined,
      {
        onEvent: async (event) => {
          if (event.kind !== "credential.changed") return;

          const offered = await credentials.offerCodexAuth(
            event.content,
            event.lastRefresh,
            core.workspaceId,
          );

          if (!offered.accepted) return;
          const status = (await credentials.status()).find((entry) => entry.key === SECRET_KEYS.codex);
          const auth = await credentials.getCodexAuth();

          if (status && auth?.version === offered.version) {
            const index = agentStatus.findIndex((entry) => entry.key === status.key);

            if (index !== -1) agentStatus[index] = status;
          }
        },
      },
    );
    core.tempod = client;
    client.sendHello({
      type: "hello",
      v: 1,
      incarnation: null,
      lastAckedSeq: 0,
      workspace: {
        id: core.workspaceId,
        slug: "model-discovery",
        branch: "main",
        baseBranch: "main",
        repo: { owner: "tempo", name: "model-discovery" },
      },
      env: {},
    });
    const discovery = client;

    const results = await Promise.allSettled(
      agents.map(async (agent) => {
        const sessionId = newId();
        const env = await agentEnv(core, agent);

        const session = await discovery.request("session.start", {
          sessionId,
          agent,
          env,
          browser: "local",
          acpSessionId: null,
        });

        try {
          const option = modelOption(session.configOptions);

          if (!option || !Schema.is(Schema.String)(option.currentValue))
            throw new TempoError("AGENT_START_FAILED", `Could not load models from ${agent}.`);
          const options = flattenConfigOptions(option);

          if (!options.length) throw new TempoError("AGENT_START_FAILED", `No models reported by ${agent}.`);

          return { agent, currentValue: option.currentValue, options };
        } finally {
          await discovery.request("session.close", { sessionId });
        }
      }),
    );

    const models = results.map((result) => {
      if (result.status === "rejected") throw result.reason;

      return result.value;
    });

    await client.drained();
    core.setKv("catalogModels", { signature: cacheSignature(), models });

    return models;
  } finally {
    client?.close();
    core.tempod = null;
    await container.destroy();
    await credentials.dropCodexLease(core.workspaceId);
    core.setKv("catalogToken", null);
    await core.ctx.storage.deleteAlarm();
  }
};
