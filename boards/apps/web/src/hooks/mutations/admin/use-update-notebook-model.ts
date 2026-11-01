import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { updateNotebookModel } from "@/fetchers/admin/update-notebook-model";
import { NOTEBOOK_MODEL_QUERY_KEY } from "@/hooks/queries/admin/use-notebook-model";
import { toast } from "@/lib/toast";
import { notebookModelSaveError } from "./notebook-model-save-error";

// Both forms of the page wait for any save in flight.
export const NOTEBOOK_MODEL_MUTATION_KEY = [
  "admin",
  "notebook-model",
  "update",
] as const;

// The settings are shared by every workspace, so every notebook status on
// screen is refreshed with them.
function useUpdateNotebookModel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: NOTEBOOK_MODEL_MUTATION_KEY,
    mutationFn: updateNotebookModel,
    onSuccess: (settings) => {
      toast.success(t("settings:adminNotebookModel.toast.saved"));
      queryClient.setQueriesData(
        { queryKey: NOTEBOOK_MODEL_QUERY_KEY },
        settings,
      );
      queryClient.invalidateQueries({ queryKey: ["notebook"] });
    },
    onError: (error, patch) => {
      toast.error(t(notebookModelSaveError(error, patch)));
    },
  });
}

export default useUpdateNotebookModel;
