import { useQuery } from "@tanstack/react-query";
import getCardHistory from "@/fetchers/forest/get-card-history";
import { forestKeys } from "./forest-keys";

function useCardHistory(workspaceId: string, taskId: string, enabled = true) {
  return useQuery({
    queryKey: [...forestKeys.card(workspaceId, taskId), "history"],
    queryFn: () => getCardHistory(workspaceId, taskId),
    enabled: enabled && Boolean(workspaceId && taskId),
    refetchInterval: 30_000,
  });
}

export default useCardHistory;
