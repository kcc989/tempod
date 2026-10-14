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

const CACHE_MS = 15 * 60_000;

const LIFETIME_MS = 10 * 60_000;

export const discoverModels = async (
  core: WorkspaceCore,
  userId: string,
): Promise<FnOutput<"listModels">> => {
  if (core.ctx.id.name !== `models:${userId}` || core.wsOrNull()) throw new TempoError("NOT_FOUND");
  core.setKv("catalogUserId", userId);
  const credentials = core.credentials();
  const status = await credentials.status();
  const keys = new Set(status.map((entry) => entry.key));

  const providers: Record<AgentId, readonly string[]> = {
    claude: [SECRET_KEYS.claude, SECRET_KEYS.anthropic],
    codex: [SECRET_KEYS.codex, SECRET_KEYS.openai],
    opencode: [SECRET_KEYS.openrouter],
    pi: [SECRET_KEYS.openrouter],
  };

  const agents = AGENT_IDS.filter((agent) => providers[agent].some((key) => keys.has(key)));

  if (!agents.length) return [];
  const container = core.container;

  if (!container) throw new TempoError("CONTAINER_START_FAILED");
  const agentStatus = status.filter((entry) => Object.values(SECRET_KEYS).some((key) => key === entry.key));
  const signature = JSON.stringify([container.images["workspace"], agentStatus]);
  const cached = core.kv<{ signature: string; at: number; models: FnOutput<"listModels"> }>("catalogModels");

  if (cached?.signature === signature && Date.now() - cached.at < CACHE_MS) return cached.models;

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
          if (event.kind === "credential.changed")
            await core.credentials().offerCodexAuth(event.content, event.lastRefresh, core.workspaceId);
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
    const models: Array<FnOutput<"listModels">[number]> = [];

    for (const agent of agents) {
      const sessionId = newId();
      const env = await agentEnv(core, agent);

      const session = await client.request("session.start", {
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
        models.push({ agent, currentValue: option.currentValue, options });
      } finally {
        await client.request("session.close", { sessionId });
      }
    }

    await client.drained();
    core.setKv("catalogModels", { signature, at: Date.now(), models });

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
