import { useQuery } from "@tanstack/react-query";
import { getPipelineSettings } from "@/fetchers/pipeline-settings/get-pipeline-settings";

export const pipelineSettingsQueryKey = (workspaceId: string) =>
  ["pipeline-settings", workspaceId] as const;

function usePipelineSettings(workspaceId: string | undefined) {
  return useQuery({
    queryKey: pipelineSettingsQueryKey(workspaceId ?? ""),
    queryFn: () => getPipelineSettings(workspaceId ?? ""),
    enabled: Boolean(workspaceId),
  });
}

export default usePipelineSettings;
