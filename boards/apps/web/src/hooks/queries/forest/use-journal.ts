import { useInfiniteQuery } from "@tanstack/react-query";
import listJournal, {
  type JournalFilter,
} from "@/fetchers/forest/list-journal";
import { forestKeys } from "./forest-keys";

function useJournal(workspaceId: string, filter: JournalFilter) {
  return useInfiniteQuery({
    queryKey: [
      ...forestKeys.all(workspaceId),
      "journal",
      filter.actor,
      filter.denied,
    ],
    queryFn: ({ pageParam }) => listJournal(workspaceId, filter, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(workspaceId),
    // Agents act through MCP and API keys without the page knowing.
    refetchInterval: 60_000,
  });
}

export default useJournal;
