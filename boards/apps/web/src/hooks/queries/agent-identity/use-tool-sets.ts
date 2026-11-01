import { useQuery } from "@tanstack/react-query";
import listToolSets from "@/fetchers/agent-identity/list-tool-sets";
import { agentKeys } from "./agent-keys";

// The sets live in the server's code, so they change only with a release.
function useToolSets() {
  return useQuery({
    queryKey: agentKeys.toolSets,
    queryFn: listToolSets,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export default useToolSets;
