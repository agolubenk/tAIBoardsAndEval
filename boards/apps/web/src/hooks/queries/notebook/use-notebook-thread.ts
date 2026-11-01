import { useQuery } from "@tanstack/react-query";
import getNotebookThread from "@/fetchers/notebook/get-notebook-thread";
import { notebookKeys } from "./notebook-keys";

function useNotebookThread(workspaceId: string, threadId: string | undefined) {
  return useQuery({
    queryKey: notebookKeys.thread(workspaceId, threadId ?? ""),
    queryFn: () => getNotebookThread(workspaceId, threadId ?? ""),
    enabled: Boolean(workspaceId && threadId),
  });
}

export default useNotebookThread;
