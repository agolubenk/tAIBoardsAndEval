import { useInfiniteQuery } from "@tanstack/react-query";
import listLogs from "@/fetchers/forest/list-logs";
import { forestKeys } from "./forest-keys";

function useLogs(workspaceId: string, q: string) {
  return useInfiniteQuery({
    queryKey: [...forestKeys.all(workspaceId), "logs", q],
    queryFn: ({ pageParam }) => listLogs(workspaceId, q, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(workspaceId),
  });
}

export default useLogs;
