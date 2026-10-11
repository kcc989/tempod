import type { AgentId } from "@tempo/protocol";
import { hasLogin } from "~/ui/lib/agents";
import { useCallQuery } from "./useCall";

/** getCredentialStatus: set or not set and last updated, per provider. */
export function useCredentialStatus() {
  return useCallQuery("getCredentialStatus", {}, { staleTime: 30_000 });
}

/** True when the agent has a login or key; undefined while loading. */
export function useHasLogin(agent: AgentId): boolean | undefined {
  const { data } = useCredentialStatus();
  return data === undefined ? undefined : hasLogin(agent, data);
}
