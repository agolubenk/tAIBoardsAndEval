import { useQuery } from "@tanstack/react-query";
import listWorkState from "@/fetchers/forest/list-work-state";
import { forestKeys } from "./forest-keys";

function useWorkState(workspaceId: string) {
  return useQuery({
    queryKey: [...forestKeys.all(workspaceId), "work-state"],
    queryFn: () => listWorkState(workspaceId),
    enabled: Boolean(workspaceId),
    // Agents write their state through MCP without the page knowing.
    refetchInterval: 60_000,
  });
}

export default useWorkState;
