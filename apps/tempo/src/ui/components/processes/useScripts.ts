import { useQueryClient } from "@tanstack/react-query";
import type { ScriptRun, ScriptRunWithLog, WorkspaceState } from "@tempo/protocol";
import { useEffect, useMemo, useRef } from "react";
import { useAction } from "~/ui/hooks/useActions";
import { callKey, useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { useWorkspaceSelector, useWorkspaceStore } from "~/ui/hooks/useWorkspace";
import { setBottomTab } from "~/ui/state/workspace-ui";
import { mergeRuns, toggleRunTarget } from "./script-runs";

/**
 * Script runs of one workspace: history from listScriptRuns (with its log tail seeded into the
 * store once per run) merged with live `script.run` messages, newest first.
 */
export function useScriptRuns(workspaceId: string) {
  const store = useWorkspaceStore(workspaceId);
  const live = useWorkspaceSelector(workspaceId, (s) => s.scriptRuns);
  const listed = useCallQuery("listScriptRuns", { workspaceId }, { staleTime: 30_000 });
  const seeded = useRef(new Set<string>());

  useEffect(() => {
    for (const r of listed.data ?? []) {
      if (seeded.current.has(r.id)) continue;
      seeded.current.add(r.id);

      if (r.logTail) store.seedScriptOutput(r.id, r.logTail);
    }
  }, [listed.data, store]);

  const runs = useMemo(() => mergeRuns(listed.data ?? [], live), [listed.data, live]);

  return {
    runs,
    isPending: listed.isPending,
    error: listed.error,
    refetch: () => void listed.refetch(),
  } satisfies {
    readonly runs: ScriptRun[];
    readonly isPending: boolean;
    readonly error: Error | null;
    readonly refetch: () => void;
  };
}

/** runScript, stopScript, rerunSetup and continueAfterSetupFailure. A new run shows at once. */
export function useScriptMutations(workspaceId: string) {
  const queryClient = useQueryClient();

  const addRun = (run: ScriptRun) =>
    queryClient.setQueryData<ReadonlyArray<ScriptRunWithLog>>(
      callKey("listScriptRuns", { workspaceId }),
      (old) => [{ ...run, logTail: "" }, ...(old ?? []).filter((r) => r.id !== run.id)],
    );

  const start = useCallMutation("runScript", { onSuccess: addRun });
  const stop = useCallMutation("stopScript");
  const rerunSetup = useCallMutation("rerunSetup", { onSuccess: addRun });
  const continueAnyway = useCallMutation("continueAfterSetupFailure");

  return { start, stop, rerunSetup, continueAnyway };
}

const NOT_LIVE: ReadonlySet<WorkspaceState> = new Set(["archiving", "archived"]);

/** ⌥R: start or stop the default run script (04). */
export function useToggleRunAction(workspaceId: string, enabled = true): void {
  const settings = useWorkspaceSelector(workspaceId, (s) => s.workspace?.settings ?? null);
  const state = useWorkspaceSelector(workspaceId, (s) => s.workspace?.state ?? null);
  const { runs } = useScriptRuns(workspaceId);
  const { start, stop } = useScriptMutations(workspaceId);
  const target = toggleRunTarget(settings, runs);
  const busy = start.isPending || stop.isPending;
  useAction(
    "toggleRun",
    () => {
      if (!target || busy) return;
      setBottomTab(workspaceId, "run");

      if (target.kind === "start") start.mutate({ workspaceId, scriptId: target.scriptId });
      else stop.mutate({ workspaceId, runId: target.runId });
    },
    { enabled: enabled && target !== null && state !== null && !NOT_LIVE.has(state) },
  );
}
