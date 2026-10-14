import { useCallQuery } from "./useCall";

export function useAgents() {
  return useCallQuery("listAgents", {}, { staleTime: 30_000 });
}
