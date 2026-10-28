import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import askNotebookThread from "@/fetchers/notebook/ask-notebook-thread";
import startNotebookThread from "@/fetchers/notebook/start-notebook-thread";
import { notebookKeys } from "@/hooks/queries/notebook/notebook-keys";
import { toast } from "@/lib/toast";

type Ask = { threadId?: string; question: string };

// Without a thread the question starts one; with it, it is a follow-up.
function useAskNotebook(workspaceId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ threadId, question }: Ask) =>
      threadId
        ? askNotebookThread({ workspaceId, threadId, question })
        : startNotebookThread(workspaceId, question),
    onSuccess: (data) =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: notebookKeys.thread(workspaceId, data.thread.id),
        }),
        queryClient.invalidateQueries({
          queryKey: notebookKeys.threads(workspaceId),
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: notebookKeys.status(workspaceId),
        }),
      ]),
    onError: (error) => {
      toast.error(error.message || t("workspace:notebook.chat.toast.error"));
    },
  });
}

export default useAskNotebook;
