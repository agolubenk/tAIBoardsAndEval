import { useQuery } from "@tanstack/react-query";
import listNotebookSources from "@/fetchers/notebook/list-notebook-sources";
import { notebookKeys } from "./notebook-keys";

function useNotebookSources(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: notebookKeys.sources(workspaceId),
    queryFn: () => listNotebookSources(workspaceId),
    enabled: enabled && Boolean(workspaceId),
  });
}

export default useNotebookSources;
