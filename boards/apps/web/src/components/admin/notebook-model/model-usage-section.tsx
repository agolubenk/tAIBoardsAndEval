import { ActivityIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsRow } from "@/components/settings/settings-row";
import { SettingsSection } from "@/components/settings/settings-section";
import type { NotebookModelSettings } from "@/fetchers/admin/get-notebook-model";

// One daily limit is shared by every workspace; this shows who spent it.
export function ModelUsageSection({
  settings,
}: {
  settings: NotebookModelSettings;
}) {
  const { t } = useTranslation();

  return (
    <SettingsSection
      title={t("settings:adminNotebookModel.usage.title")}
      description={t("settings:adminNotebookModel.usage.total", {
        count: settings.callsToday,
        max: settings.dailyMax,
      })}
    >
      <SettingsCard>
        {settings.usage.length === 0 ? (
          <p className="px-4 py-3.5 text-muted-foreground text-sm">
            {t("settings:adminNotebookModel.usage.empty")}
          </p>
        ) : (
          settings.usage.map((row) => (
            <SettingsRow
              key={row.workspaceId}
              icon={<ActivityIcon />}
              title={row.name}
              description={t("settings:adminNotebookModel.usage.calls", {
                count: row.calls,
              })}
            />
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
