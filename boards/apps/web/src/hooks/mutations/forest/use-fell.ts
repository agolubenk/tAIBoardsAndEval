import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import fell from "@/fetchers/forest/fell";
import { forestKeys } from "@/hooks/queries/forest/forest-keys";
import { toast } from "@/lib/toast";

function useFell(workspaceId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: fell,
    onSuccess: (result) => {
      toast.success(
        t("workspace:forest.fell.toast.done", {
          tasks: result.taskCount,
          seeds: result.seedCount,
        }),
      );
      // Felling deletes the tasks: boards and project counts change as well.
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: forestKeys.all(workspaceId),
        }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
        queryClient.invalidateQueries({ queryKey: ["projects", workspaceId] }),
      ]);
    },
    onError: (error) => {
      toast.error(error.message || t("workspace:forest.fell.toast.error"));
    },
  });
}

export default useFell;
