import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { PipelineSettingsView } from "@/fetchers/pipeline-settings/get-pipeline-settings";
import {
  type PipelineSettingsPatch,
  updatePipelineSettings,
} from "@/fetchers/pipeline-settings/update-pipeline-settings";
import { pipelineSettingsQueryKey } from "@/hooks/queries/pipeline-settings/use-pipeline-settings";
import { toast } from "@/lib/toast";

// A switch flips at once; a refused save puts it back and says why.
function useUpdatePipelineSettings(workspaceId: string | undefined) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = pipelineSettingsQueryKey(workspaceId ?? "");

  return useMutation({
    mutationKey: key,
    mutationFn: (patch: PipelineSettingsPatch) =>
      updatePipelineSettings(workspaceId ?? "", patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<PipelineSettingsView>(key);
      if (previous) {
        queryClient.setQueryData<PipelineSettingsView>(key, {
          ...previous,
          automation: patch.automation ?? previous.automation,
          toggles: { ...previous.toggles, ...patch.toggles },
        });
      }
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      toast.error(t("settings:workspacePipeline.saveFailed"));
    },
    // Each answer reflects only the saves before it: with clicks in flight, writing
    // it back would flip a later switch back. Read the truth once the last save ends.
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey: key }) <= 1) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export default useUpdatePipelineSettings;
