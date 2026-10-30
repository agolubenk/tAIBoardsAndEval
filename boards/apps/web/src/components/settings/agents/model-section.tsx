import { Link } from "@tanstack/react-router";
import { CpuIcon, FileKeyIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsNote } from "@/components/settings/settings-note";
import { SettingsRow } from "@/components/settings/settings-row";
import { SettingsRowsSkeleton } from "@/components/settings/settings-rows-skeleton";
import { SettingsSection } from "@/components/settings/settings-section";
import { StatusBadge } from "@/components/settings/status-badge";
import { Button } from "@/components/ui/button";
import useAdminAccess from "@/hooks/queries/admin/use-admin-access";
import useNotebookStatus from "@/hooks/queries/notebook/use-notebook-status";
import useActiveWorkspace from "@/hooks/queries/workspace/use-active-workspace";

// The model the notebook answers with and its daily budget. One model serves
// every workspace on the instance, so only an instance admin changes it.
export function ModelSection() {
  const { t } = useTranslation();
  const { data: workspace } = useActiveWorkspace();
  const { data, isPending, isError } = useNotebookStatus(workspace?.id ?? "");
  const { data: isInstanceAdmin } = useAdminAccess();

  const renderModel = () => {
    if (!workspace || isPending) return <SettingsRowsSkeleton rows={1} />;
    if (isError || !data) {
      return (
        <p
          role="alert"
          className="px-4 py-3.5 text-destructive-foreground text-sm"
        >
          {t("settings:agentsPage.model.loadError")}
        </p>
      );
    }
    const { llm } = data;
    return (
      <SettingsRow
        icon={<CpuIcon />}
        title={llm.model ?? t("settings:agentsPage.model.none")}
        badge={
          <StatusBadge tone={llm.configured ? "success" : "warning"}>
            {llm.configured
              ? t("settings:agentsPage.model.keyFound")
              : t("settings:agentsPage.model.keyMissing")}
          </StatusBadge>
        }
        description={
          llm.dailyMax === null
            ? t("settings:agentsPage.model.callsToday", {
                count: llm.callsToday,
              })
            : t("settings:agentsPage.model.callsOfMax", {
                count: llm.callsToday,
                max: llm.dailyMax,
              })
        }
      />
    );
  };

  return (
    <SettingsSection
      title={t("settings:agentsPage.model.title")}
      description={t("settings:agentsPage.model.description")}
      action={
        isInstanceAdmin ? (
          <Button
            size="sm"
            variant="outline"
            render={<Link to="/dashboard/settings/admin/notebook-model" />}
          >
            {t("settings:agentsPage.model.configure")}
          </Button>
        ) : undefined
      }
    >
      <SettingsCard>{renderModel()}</SettingsCard>
      <SettingsNote icon={FileKeyIcon}>
        {t("settings:agentsPage.model.note")}
      </SettingsNote>
    </SettingsSection>
  );
}
