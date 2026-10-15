import { Schema } from "effect";
import { API, type FnName } from "./api.ts";
import { Deployment } from "./types.ts";

/** 12, Agent tools. */
export const DEPLOY_TOOL_NAMES = [
  "deploy_app",
  "list_deployments",
  "get_deployment",
  "get_deployment_log",
] as const;

export const DeployToolName = Schema.Literals(DEPLOY_TOOL_NAMES);

export type DeployToolName = typeof DeployToolName.Type;

/** The tool log tail: at most the last 64 KiB (12, Agent tools). */
export const DEPLOY_TOOL_LOG_BYTES = 64 * 1024;

const projectInput = <F extends Schema.Struct.Fields & { readonly projectId: typeof Schema.String }>(
  schema: Schema.Struct<F>,
) => {
  const { projectId: _projectId, ...fields } = schema.fields;

  return Schema.Struct(fields);
};

export const DEPLOY_TOOLS = {
  deploy_app: {
    fn: "startDeployment",
    mutates: true,
    input: Schema.Struct({ target: Schema.String.check(Schema.isMinLength(1)) }),
    description:
      "Deploy this workspace's branch at its current pushed tip to a Cloudflare target of this Tempo repository. Only targets the owner marked for agents can be used. Push your commits first. Returns the queued deployment; check it with get_deployment. Requires a writable run or interactive chat.",
  },
  list_deployments: {
    fn: "listDeployments",
    mutates: false,
    input: projectInput(API.listDeployments.input),
    description:
      "List this repository's deployments, newest first, optionally for one target; pages contain up to 50.",
  },
  get_deployment: {
    fn: "getDeployment",
    mutates: false,
    input: projectInput(API.getDeployment.input),
    description: "Read one deployment's status, conclusion, exit code and summary.",
  },
  get_deployment_log: {
    fn: "getDeploymentLog",
    mutates: false,
    input: projectInput(API.getDeploymentLog.input),
    description: "Read the last 64 KiB of a deployment's log (live while it runs).",
  },
} satisfies Record<DeployToolName, { fn: FnName; mutates: boolean; input: Schema.Top; description: string }>;

export const DeploymentToolPage = Schema.Struct({
  items: Schema.Array(Deployment),
  nextOffset: Schema.NullOr(Schema.Number),
});
