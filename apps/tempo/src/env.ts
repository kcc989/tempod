import type { CredentialDO } from "./do/credential.ts";
import type { UserHubDO } from "./do/user-hub.ts";
import type { WorkspaceDO } from "./do/workspace/index.ts";

interface TempoEnv {
  readonly DB: D1Database;
  readonly DATA: R2Bucket;
  readonly WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  readonly USER_HUB: DurableObjectNamespace<UserHubDO>;
  readonly CREDENTIALS: DurableObjectNamespace<CredentialDO>;
  readonly APP_HOST: string;
  readonly PREVIEW_DOMAIN: string;
  readonly TEMPO_OWNER_GITHUB_ID: string;
  readonly TEMPO_ENCRYPTION_KEY: string;
  readonly BETTER_AUTH_SECRET: string;
  readonly TEMPO_SETUP_TOKEN: string;
  /** Optional: version string shown in /api/v1/meta. */
  readonly TEMPO_VERSION?: string;
}

export type Env = TempoEnv;

declare global {
  namespace Cloudflare {
    interface Env extends TempoEnv {}
    interface GlobalProps {
      mainModule: typeof import("./worker.ts");
      durableNamespaces: "WorkspaceDO" | "UserHubDO" | "CredentialDO";
    }
  }
}
