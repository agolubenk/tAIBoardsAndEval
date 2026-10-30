import { useQuery } from "@tanstack/react-query";
import getCardPlace from "@/fetchers/forest/get-card-place";
import { forestKeys } from "./forest-keys";

function useCardPlace(workspaceId: string, taskId: string) {
  return useQuery({
    queryKey: [...forestKeys.card(workspaceId, taskId), "place"],
    queryFn: () => getCardPlace(workspaceId, taskId),
    enabled: Boolean(workspaceId && taskId),
  });
}

export default useCardPlace;
