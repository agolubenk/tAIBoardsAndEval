import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import setAgentEnabled from "@/fetchers/agent-identity/set-agent-enabled";
import { agentKeys } from "@/hooks/queries/agent-identity/agent-keys";
import { toast } from "@/lib/toast";

function useSetAgentEnabled() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ agentId, enabled }: { agentId: string; enabled: boolean }) =>
      setAgentEnabled(agentId, enabled),
    onSuccess: (result) => {
      toast.success(
        result.enabled
          ? t("settings:agentsPage.toast.enabled")
          : t("settings:agentsPage.toast.disabled", {
              count: result.revokedKeys,
            }),
      );
      return queryClient.invalidateQueries({ queryKey: agentKeys.all });
    },
    onError: (error) => {
      toast.error(error.message || t("settings:agentsPage.toast.error"));
    },
  });
}

export default useSetAgentEnabled;
