import type { WorkspaceCore } from "./core.ts";

export const syncIdleCredentials = async (core: WorkspaceCore, beforeStart = false): Promise<void> => {
  if (
    core.credentialsBusy ||
    core.runningTurn() ||
    core.turnEndInProgress ||
    (core.queueBusy && !beforeStart)
  )
    return;
  core.credentialsBusy = true;

  try {
    const offered = core.pendingCodexAuth;

    if (offered) {
      await core.credentials().offerCodexAuth(offered.content, offered.lastRefresh, core.workspaceId);

      if (core.pendingCodexAuth === offered) core.pendingCodexAuth = null;
    }

    if (!core.tempod?.open || core.runningTurn() || core.turnEndInProgress) return;
    const pushed = core.pendingCodexPush;

    if (pushed) {
      await core.tempod.request("credential.put", { provider: "codex", ...pushed });

      if (core.pendingCodexPush === pushed) core.pendingCodexPush = null;
    }
  } finally {
    core.credentialsBusy = false;
    core.kickQueue();
  }
};
