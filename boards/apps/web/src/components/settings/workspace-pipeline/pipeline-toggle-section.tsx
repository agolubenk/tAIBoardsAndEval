import type { PipelineToggle } from "@kaneo/permissions";
import { useTranslation } from "react-i18next";
import { PreferenceSwitchRow } from "@/components/settings/preferences/preference-switch-row";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsSection } from "@/components/settings/settings-section";

type PipelineToggleSectionProps = {
  title: string;
  description: string;
  names: PipelineToggle[];
  values: Record<PipelineToggle, boolean>;
  disabled: boolean;
  onChange: (name: PipelineToggle, value: boolean) => void;
};

export function PipelineToggleSection({
  title,
  description,
  names,
  values,
  disabled,
  onChange,
}: PipelineToggleSectionProps) {
  const { t } = useTranslation();
  return (
    <SettingsSection title={title} description={description}>
      <SettingsCard>
        {names.map((name) => (
          <PreferenceSwitchRow
            key={name}
            title={t(`settings:workspacePipeline.toggles.${name}.title`)}
            description={t(
              `settings:workspacePipeline.toggles.${name}.description`,
            )}
            checked={values[name]}
            disabled={disabled}
            onCheckedChange={(value) => onChange(name, value)}
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}
