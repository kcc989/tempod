import { useCallQuery } from "./useCall";

/** listCustomAgents (01, Custom agents): the user's custom agents, sorted by name. */
export function useCustomAgents() {
  return useCallQuery("listCustomAgents", {}, { staleTime: 30_000 });
}
