import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import grow from "@/fetchers/forest/grow";
import { forestKeys } from "@/hooks/queries/forest/forest-keys";
import { toast } from "@/lib/toast";

function useGrow(workspaceId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: grow,
    onSuccess: (result) => {
      toast.success(
        t("workspace:forest.grow.toast.done", { tasks: result.taskIds.length }),
      );
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: forestKeys.all(workspaceId),
        }),
        queryClient.invalidateQueries({ queryKey: ["projects", workspaceId] }),
      ]);
    },
    onError: (error) => {
      toast.error(error.message || t("workspace:forest.grow.toast.error"));
    },
  });
}

export default useGrow;
