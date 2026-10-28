import { useQuery } from "@tanstack/react-query";
import listLeases from "@/fetchers/forest/list-leases";
import { forestKeys } from "./forest-keys";

function useLeases(workspaceId: string) {
  return useQuery({
    queryKey: [...forestKeys.all(workspaceId), "leases"],
    queryFn: () => listLeases(workspaceId),
    enabled: Boolean(workspaceId),
    // Leases expire on their own; a minute is enough to keep the list honest.
    refetchInterval: 60_000,
  });
}

export default useLeases;
