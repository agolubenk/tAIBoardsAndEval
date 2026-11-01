import { useQuery } from "@tanstack/react-query";
import listNotebookThreads from "@/fetchers/notebook/list-notebook-threads";
import { notebookKeys } from "./notebook-keys";

function useNotebookThreads(workspaceId: string) {
  return useQuery({
    queryKey: notebookKeys.threads(workspaceId),
    queryFn: () => listNotebookThreads(workspaceId),
    enabled: Boolean(workspaceId),
  });
}

export default useNotebookThreads;
