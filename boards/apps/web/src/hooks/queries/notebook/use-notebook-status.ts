import { useQuery } from "@tanstack/react-query";
import getNotebookStatus from "@/fetchers/notebook/get-notebook-status";
import { notebookKeys } from "./notebook-keys";

// The embedding worker runs on a Mac that may sleep; its online flag is worth
// refreshing while the page is open.
function useNotebookStatus(workspaceId: string) {
  return useQuery({
    queryKey: notebookKeys.status(workspaceId),
    queryFn: () => getNotebookStatus(workspaceId),
    enabled: Boolean(workspaceId),
    refetchInterval: 30_000,
  });
}

export default useNotebookStatus;
