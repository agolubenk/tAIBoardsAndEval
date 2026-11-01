import { useQuery } from "@tanstack/react-query";
import listSectors from "@/fetchers/forest/list-sectors";
import { forestKeys } from "./forest-keys";

function useSectors(workspaceId: string) {
  return useQuery({
    queryKey: [...forestKeys.all(workspaceId), "sectors"],
    queryFn: () => listSectors(workspaceId),
    enabled: Boolean(workspaceId),
  });
}

export default useSectors;
