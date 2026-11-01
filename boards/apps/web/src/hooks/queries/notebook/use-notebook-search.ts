import { useQuery } from "@tanstack/react-query";
import searchNotebook from "@/fetchers/notebook/search-notebook";
import { notebookKeys } from "./notebook-keys";

// Runs only for a submitted query; the same query again reads the cache.
function useNotebookSearch(workspaceId: string, query: string) {
  return useQuery({
    queryKey: notebookKeys.search(workspaceId, query),
    queryFn: () => searchNotebook(workspaceId, query),
    enabled: Boolean(workspaceId && query),
    staleTime: 60_000,
    retry: false,
  });
}

export default useNotebookSearch;
