import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import detectSectors from "@/fetchers/forest/detect-sectors";
import { forestKeys } from "@/hooks/queries/forest/forest-keys";
import { toast } from "@/lib/toast";

function useDetectSectors(workspaceId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => detectSectors(workspaceId),
    onSuccess: (sectors) => {
      toast.success(
        t("workspace:forest.sectors.toast.detected", {
          created: sectors.filter((sector) => sector.created).length,
        }),
      );
      return queryClient.invalidateQueries({
        queryKey: forestKeys.all(workspaceId),
      });
    },
    onError: (error) => {
      toast.error(
        error.message || t("workspace:forest.sectors.toast.detectError"),
      );
    },
  });
}

export default useDetectSectors;
