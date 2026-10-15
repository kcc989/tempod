import {
  DEPLOY_TOOLS,
  DEPLOY_TOOL_LOG_BYTES,
  DeployToolName,
  MAX_MESSAGE_BYTES,
  TempoError,
  unwrap,
  type Deployment,
  type ToolReq,
} from "@tempo/protocol";
import { Schema } from "effect";
import type { WorkspaceCore } from "../do/workspace/core.ts";
import { sessionManifest } from "../do/workspace/manifest.ts";
import { requireProject } from "../server/handlers/common.ts";
import * as handlers from "../server/handlers/deploy.ts";
import { authorizeProjectTool } from "./issues.ts";

const json = (value: Deployment | ReadonlyArray<Deployment> | { text: string; truncated: boolean }) =>
  Schema.decodeUnknownSync(Schema.Json)(value);

/** The last `max` bytes of a log, cut on a character boundary (12, Agent tools). */
const tail = (text: string, max = DEPLOY_TOOL_LOG_BYTES) => {
  const bytes = new TextEncoder().encode(text);

  if (bytes.byteLength <= max) return { text, cut: false };
  let start = bytes.byteLength - max;

  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start++;

  return { text: new TextDecoder().decode(bytes.subarray(start)), cut: true };
};

const page = (items: ReadonlyArray<Deployment>, offset = 0): Schema.Json => {
  const bounded: Deployment[] = [];
  let bytes = 0;

  for (const item of items) {
    const size = new TextEncoder().encode(JSON.stringify(item)).length + 1;

    if (bytes + size > MAX_MESSAGE_BYTES - 1024) break;
    bounded.push(item);
    bytes += size;
  }

  return Schema.decodeUnknownSync(Schema.Json)({
    items: bounded,
    nextOffset: bounded.length < items.length || items.length === 50 ? offset + bounded.length : null,
  });
};

/** The deploy tools of the `tempo` MCP server (12, Agent tools). */
export const deployTool = async (core: WorkspaceCore, request: ToolReq): Promise<Schema.Json> => {
  try {
    if (!Schema.is(DeployToolName)(request.op)) throw new TempoError("UNKNOWN_OP");
    const name = request.op;

    const { ctx, ws } = await authorizeProjectTool(
      core,
      request,
      name,
      DEPLOY_TOOLS[name].mutates,
      "Read-only runs cannot deploy.",
    );

    const decode = { onExcessProperty: "error" } as const;
    const projectId = ws.projectId;

    switch (name) {
      case "deploy_app": {
        const { target } = Schema.decodeUnknownSync(DEPLOY_TOOLS.deploy_app.input, decode)(request.params);
        // 14, Enforcement: deploy_app checks the session's deploy capability first.
        const manifest = await sessionManifest(core, core.sessionRow(request.sessionId));

        if (!manifest.deploy.some((d) => d.target === target))
          throw new TempoError("FORBIDDEN", undefined, `tempo: capability deploy:${target} not granted`);
        const project = await requireProject(core.env, ws.userId, projectId);

        if (project.provider !== "artifacts")
          throw new TempoError(
            "VALIDATION_FAILED",
            undefined,
            "App deploys are only for Tempo-hosted repositories.",
          );

        return json(
          unwrap(
            await core.env.APP_DEPLOY.getByName(projectId).start({
              target,
              branch: ws.branch,
              trigger: "agent",
              workspaceId: ws.workspaceId,
            }),
          ),
        );
      }

      case "list_deployments": {
        const input = Schema.decodeUnknownSync(DEPLOY_TOOLS.list_deployments.input, decode)(request.params);

        return page(await handlers.listDeployments(ctx, { projectId, ...input }), input.offset);
      }

      case "get_deployment":
        return json(
          await handlers.getDeployment(ctx, {
            projectId,
            ...Schema.decodeUnknownSync(DEPLOY_TOOLS.get_deployment.input, decode)(request.params),
          }),
        );
      case "get_deployment_log": {
        const log = await handlers.getDeploymentLog(ctx, {
          projectId,
          ...Schema.decodeUnknownSync(DEPLOY_TOOLS.get_deployment_log.input, decode)(request.params),
        });

        const cut = tail(log.text);

        return json({ text: cut.text, truncated: log.truncated || cut.cut });
      }
    }
  } catch (cause) {
    if (cause instanceof TempoError) throw cause;

    if (Schema.isSchemaError(cause))
      throw new TempoError("VALIDATION_FAILED", undefined, "Invalid deploy tool input or session profile.");
    throw new TempoError("INTERNAL", undefined, "Deploy tool failed.");
  }
};
