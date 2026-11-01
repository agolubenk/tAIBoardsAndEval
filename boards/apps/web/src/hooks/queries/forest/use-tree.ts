import { useQuery } from "@tanstack/react-query";
import getTree from "@/fetchers/forest/get-tree";
import { forestKeys } from "./forest-keys";

// Branches load only when a tree is opened.
function useTree(workspaceId: string, rootId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...forestKeys.all(workspaceId), "tree", rootId],
    queryFn: () => getTree(workspaceId, rootId),
    enabled: enabled && Boolean(workspaceId && rootId),
  });
}

export default useTree;
