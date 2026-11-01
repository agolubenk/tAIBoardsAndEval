import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import deleteNotebookThread from "@/fetchers/notebook/delete-notebook-thread";
import { notebookKeys } from "@/hooks/queries/notebook/notebook-keys";
import { toast } from "@/lib/toast";

function useDeleteNotebookThread(workspaceId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (threadId: string) =>
      deleteNotebookThread(workspaceId, threadId),
    onSuccess: (_, threadId) => {
      queryClient.removeQueries({
        queryKey: notebookKeys.thread(workspaceId, threadId),
      });
      toast.success(t("workspace:notebook.chat.toast.deleted"));
      return queryClient.invalidateQueries({
        queryKey: notebookKeys.threads(workspaceId),
        exact: true,
      });
    },
    onError: (error) => {
      toast.error(
        error.message || t("workspace:notebook.chat.toast.deleteError"),
      );
    },
  });
}

export default useDeleteNotebookThread;
