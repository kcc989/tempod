import { env as bindings, exports } from "cloudflare:workers";
import { withWorkspace } from "../../src/env.ts";

// The test Worker's env as handlers receive it: WORKSPACE comes from exports (01, Worker config).
export const env = withWorkspace(bindings, exports);
