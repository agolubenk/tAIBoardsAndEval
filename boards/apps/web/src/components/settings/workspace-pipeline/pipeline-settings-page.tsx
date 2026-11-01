import {
  PIPELINE_TOGGLE_NAMES,
  type PipelineToggle,
  pipelineToggles,
} from "@kaneo/permissions";
import { useTranslation } from "react-i18next";
import PageTitle from "@/components/page-title";
import { PreferenceSwitchRow } from "@/components/settings/preferences/preference-switch-row";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsNote } from "@/components/settings/settings-note";
import { SettingsPage } from "@/components/settings/settings-page";
import { SettingsRowsSkeleton } from "@/components/settings/settings-rows-skeleton";
import { SettingsSection } from "@/components/settings/settings-section";
import { PipelineToggleSection } from "@/components/settings/workspace-pipeline/pipeline-toggle-section";
import useUpdatePipelineSettings from "@/hooks/mutations/pipeline-settings/use-update-pipeline-settings";
import usePipelineSettings from "@/hooks/queries/pipeline-settings/use-pipeline-settings";
import useActiveWorkspace from "@/hooks/queries/workspace/use-active-workspace";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";

const inGroup = (group: "evolution" | "pipeline") =>
  PIPELINE_TOGGLE_NAMES.filter((name) => pipelineToggles[name].group === group);

export function PipelineSettingsPage() {
  const { t } = useTranslation();
  const { data: workspace } = useActiveWorkspace();
  const {
    data: settings,
    isPending,
    isError,
  } = usePipelineSettings(workspace?.id);
  const update = useUpdatePipelineSettings(workspace?.id);
  const { canManageSettings } = useWorkspacePermission();
  const canEdit = canManageSettings();

  const setToggle = (name: PipelineToggle, value: boolean) =>
    update.mutate({ toggles: { [name]: value } });

  return (
    <>
      <PageTitle title={t("settings:workspacePipeline.pageTitle")} />
      <SettingsPage
        title={t("settings:workspacePipeline.title")}
        description={t("settings:workspacePipeline.subtitle")}
      >
        {!canEdit ? (
          <SettingsNote>
            {t("settings:workspacePipeline.readOnly")}
          </SettingsNote>
        ) : null}
        {isError ? (
          <SettingsNote>
            {t("settings:workspacePipeline.loadFailed")}
          </SettingsNote>
        ) : isPending || !settings ? (
          <SettingsRowsSkeleton />
        ) : (
          <>
            <SettingsSection
              title={t("settings:workspacePipeline.masterTitle")}
            >
              <SettingsCard>
                <PreferenceSwitchRow
                  title={t("settings:workspacePipeline.automation.title")}
                  description={t(
                    "settings:workspacePipeline.automation.description",
                  )}
                  checked={settings.automation}
                  disabled={!canEdit}
                  onCheckedChange={(value) =>
                    update.mutate({ automation: value })
                  }
                />
              </SettingsCard>
            </SettingsSection>
            <PipelineToggleSection
              title={t("settings:workspacePipeline.evolutionTitle")}
              description={t("settings:workspacePipeline.evolutionSubtitle")}
              names={inGroup("evolution")}
              values={settings.toggles}
              disabled={!canEdit || !settings.automation}
              onChange={setToggle}
            />
            <PipelineToggleSection
              title={t("settings:workspacePipeline.pipelineTitle")}
              description={t("settings:workspacePipeline.pipelineSubtitle")}
              names={inGroup("pipeline")}
              values={settings.toggles}
              disabled={!canEdit || !settings.automation}
              onChange={setToggle}
            />
          </>
        )}
      </SettingsPage>
    </>
  );
}
