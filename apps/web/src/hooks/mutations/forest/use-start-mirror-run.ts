import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import startMirrorRun from "@/fetchers/forest/start-mirror-run";
import { forestKeys } from "@/hooks/queries/forest/forest-keys";
import { toast } from "@/lib/toast";

function useStartMirrorRun(workspaceId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => startMirrorRun(workspaceId),
    onSuccess: () => {
      toast.success(t("workspace:forest.mirror.toast.started"));
      return queryClient.invalidateQueries({
        queryKey: [...forestKeys.all(workspaceId), "mirror"],
      });
    },
    onError: (error) => {
      toast.error(error.message || t("workspace:forest.mirror.toast.error"));
    },
  });
}

export default useStartMirrorRun;
