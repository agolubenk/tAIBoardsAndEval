import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { updateNotebookModel } from "@/fetchers/admin/update-notebook-model";
import { NOTEBOOK_MODEL_QUERY_KEY } from "@/hooks/queries/admin/use-notebook-model";
import { toast } from "@/lib/toast";

// The settings are shared by every workspace, so every notebook status on
// screen is refreshed with them.
function useUpdateNotebookModel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updateNotebookModel,
    onSuccess: (settings) => {
      toast.success(t("settings:adminNotebookModel.toast.saved"));
      queryClient.setQueriesData(
        { queryKey: NOTEBOOK_MODEL_QUERY_KEY },
        settings,
      );
      queryClient.invalidateQueries({ queryKey: ["notebook"] });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t("settings:adminNotebookModel.toast.saveError"),
      );
    },
  });
}

export default useUpdateNotebookModel;
