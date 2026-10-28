import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import rollbackCardHistory from "@/fetchers/forest/rollback-card-history";
import { forestKeys } from "@/hooks/queries/forest/forest-keys";
import { toast } from "@/lib/toast";

function useRollbackCard(workspaceId: string, taskId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: rollbackCardHistory,
    onSuccess: () => {
      toast.success(t("tasks:card.toast.rolledBack"));
      // A task rollback changes the title, text or status kaneo shows too.
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: forestKeys.card(workspaceId, taskId),
        }),
        queryClient.invalidateQueries({ queryKey: ["task", taskId] }),
        queryClient.invalidateQueries({ queryKey: ["activities", taskId] }),
      ]);
    },
    onError: (error) => {
      toast.error(error.message || t("tasks:card.toast.rollbackError"));
    },
  });
}

export default useRollbackCard;
