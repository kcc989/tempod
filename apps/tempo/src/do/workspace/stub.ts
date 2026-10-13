import type { FnOutput, Result, WorkspaceFnName } from "@tempo/protocol";
import type { WorkspaceDO } from "./index.ts";
import type { MethodInput } from "./rpc.ts";

/** The generated methods return Result envelopes; Cloudflare's mapped stub types lose union branches. */
type WorkspaceRpcMethods = {
  [K in WorkspaceFnName]: (input: MethodInput<K>) => Promise<Result<FnOutput<K>>>;
};

export type WorkspaceStub = WorkspaceRpcMethods & DurableObjectStub<WorkspaceDO>;

export const workspaceStub = (namespace: DurableObjectNamespace<WorkspaceDO>, name: string): WorkspaceStub =>
  namespace.getByName(name);
