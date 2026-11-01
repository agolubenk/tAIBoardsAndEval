import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import decideApproval from "@/fetchers/forest/decide-approval";
import { forestKeys } from "@/hooks/queries/forest/forest-keys";
import { toast } from "@/lib/toast";

function useDecideApproval(workspaceId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: decideApproval,
    onSuccess: (approval) => {
      toast.success(
        approval.status === "approved"
          ? t("workspace:forest.approvals.toast.approved")
          : t("workspace:forest.approvals.toast.rejected"),
      );
      return queryClient.invalidateQueries({
        queryKey: forestKeys.all(workspaceId),
      });
    },
    onError: (error) => {
      toast.error(
        error.message || t("workspace:forest.approvals.toast.decideError"),
      );
    },
  });
}

export default useDecideApproval;
