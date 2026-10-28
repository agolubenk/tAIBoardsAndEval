import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import updateCardMeta from "@/fetchers/forest/update-card-meta";
import { forestKeys } from "@/hooks/queries/forest/forest-keys";
import { toast } from "@/lib/toast";

function useUpdateCardMeta(workspaceId: string, taskId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updateCardMeta,
    onSuccess: () => {
      toast.success(t("tasks:card.toast.saved"));
      return queryClient.invalidateQueries({
        queryKey: forestKeys.card(workspaceId, taskId),
      });
    },
    onError: (error) => {
      toast.error(error.message || t("tasks:card.toast.saveError"));
    },
  });
}

export default useUpdateCardMeta;
