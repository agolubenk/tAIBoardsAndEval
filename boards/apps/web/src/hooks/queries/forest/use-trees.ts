import { useQuery } from "@tanstack/react-query";
import listTrees from "@/fetchers/forest/list-trees";
import { forestKeys } from "./forest-keys";

function useTrees(workspaceId: string, projectId?: string) {
  return useQuery({
    queryKey: [...forestKeys.all(workspaceId), "trees", projectId ?? "all"],
    queryFn: () => listTrees(workspaceId, projectId),
    enabled: Boolean(workspaceId),
  });
}

export default useTrees;
