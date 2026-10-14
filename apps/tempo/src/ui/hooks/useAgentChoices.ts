import type { AgentId } from "@tempo/protocol";
import { useAgents } from "./useAgents";

export function useAgentChoices(defaultAgent: AgentId) {
  const query = useAgents();

  return {
    ...query,
    data: query.data?.map((a) => ({ ...a, baseAgent: a.baseAgent === "auto" ? defaultAgent : a.baseAgent })),
  };
}
