import { useInfiniteQuery } from "@tanstack/react-query";
import getGraph from "@/fetchers/forest/get-graph";
import { forestKeys } from "./forest-keys";

// Pages of 100 nodes; the graph tab asks for more when the reader wants them.
function useGraph(workspaceId: string) {
  return useInfiniteQuery({
    queryKey: [...forestKeys.all(workspaceId), "graph"],
    queryFn: ({ pageParam }) => getGraph(workspaceId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(workspaceId),
    staleTime: 60_000,
  });
}

export default useGraph;
