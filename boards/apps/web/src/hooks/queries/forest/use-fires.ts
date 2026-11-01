import { useQuery } from "@tanstack/react-query";
import listFires from "@/fetchers/forest/list-fires";
import { forestKeys } from "./forest-keys";

function useFires(workspaceId: string) {
  return useQuery({
    queryKey: [...forestKeys.all(workspaceId), "fires"],
    queryFn: () => listFires(workspaceId),
    enabled: Boolean(workspaceId),
    refetchInterval: 60_000,
  });
}

export default useFires;
