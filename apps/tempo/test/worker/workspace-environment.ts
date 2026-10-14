import type { Env } from "../../src/env.ts";
import type { Result, WorkspaceSummary } from "@tempo/protocol";
import type { InitInput } from "../../src/do/workspace/index.ts";
import { workspaceStub, type WorkspaceStub } from "../../src/do/workspace/stub.ts";

export const withWorkspaceInit = (
  environment: Env,
  initialize: (stub: WorkspaceStub, input: InitInput) => Promise<Result<WorkspaceSummary>>,
): Env => ({
  ...environment,
  WORKSPACE: new Proxy(environment.WORKSPACE, {
    get(namespace, key) {
      if (key === "getByName")
        return (name: string) => {
          const stub = workspaceStub(namespace, name);

          return new Proxy(stub, {
            get(target, method) {
              if (method === "init") return (input: InitInput) => initialize(stub, input);

              throw new Error(`Unexpected workspace method: ${String(method)}`);
            },
          });
        };

      throw new Error(`Unexpected workspace namespace method: ${String(key)}`);
    },
  }),
});
