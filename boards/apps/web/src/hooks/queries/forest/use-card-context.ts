import { useQuery } from "@tanstack/react-query";
import getCardContext from "@/fetchers/forest/get-card-context";
import { forestKeys } from "./forest-keys";

function useCardContext(workspaceId: string, taskId: string) {
  return useQuery({
    queryKey: [...forestKeys.card(workspaceId, taskId), "context"],
    queryFn: () => getCardContext(workspaceId, taskId),
    enabled: Boolean(workspaceId && taskId),
    // Agents take leases and ask for «да» without the page knowing.
    refetchInterval: 30_000,
  });
}

export default useCardContext;
