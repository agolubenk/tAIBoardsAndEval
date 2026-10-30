import { KeyRoundIcon, LockIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsNote } from "@/components/settings/settings-note";
import { SettingsRow } from "@/components/settings/settings-row";
import { SettingsSection } from "@/components/settings/settings-section";
import { StatusBadge } from "@/components/settings/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { NotebookModelSettings } from "@/fetchers/admin/get-notebook-model";
import useUpdateNotebookModel from "@/hooks/mutations/admin/use-update-notebook-model";
import { MODEL_KEY_TONE, modelKeyStatus } from "./model-key-status";

// The key is write-only: the API says where it comes from, never what it is.
export function ModelKeySection({
  settings,
}: {
  settings: NotebookModelSettings;
}) {
  const { t } = useTranslation();
  const [key, setKey] = useState("");
  const { mutate, isPending, variables } = useUpdateNotebookModel();
  const status = modelKeyStatus(settings);
  const canRemove = settings.keySource === "settings" || settings.keyUnreadable;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const value = key.trim();
    if (value === "") return;
    mutate({ key: value }, { onSuccess: () => setKey("") });
  };

  return (
    <SettingsSection
      title={t("settings:adminNotebookModel.key.title")}
      description={t("settings:adminNotebookModel.key.description")}
    >
      <SettingsCard>
        <SettingsRow
          icon={<KeyRoundIcon />}
          title={t("settings:adminNotebookModel.key.current")}
          badge={
            <StatusBadge tone={MODEL_KEY_TONE[status]}>
              {t(`settings:adminNotebookModel.key.status.${status}`)}
            </StatusBadge>
          }
        >
          {canRemove ? (
            <Button
              size="sm"
              variant="destructive-outline"
              loading={isPending && variables?.key === null}
              disabled={isPending}
              onClick={() => mutate({ key: null })}
            >
              {t("settings:adminNotebookModel.key.remove")}
            </Button>
          ) : null}
        </SettingsRow>
        <form onSubmit={onSubmit}>
          <SettingsRow
            stack
            title={
              <label htmlFor="notebook-model-key">
                {t("settings:adminNotebookModel.key.newLabel")}
              </label>
            }
          >
            <Input
              id="notebook-model-key"
              type="password"
              size="sm"
              className="sm:w-64"
              autoComplete="off"
              maxLength={500}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              disabled={!settings.canStoreKey || isPending}
            />
            <Button
              type="submit"
              size="sm"
              loading={isPending && typeof variables?.key === "string"}
              disabled={!settings.canStoreKey || key.trim() === ""}
            >
              {t("settings:adminNotebookModel.key.save")}
            </Button>
          </SettingsRow>
        </form>
      </SettingsCard>
      <SettingsNote icon={LockIcon}>
        {settings.canStoreKey
          ? t("settings:adminNotebookModel.key.note")
          : t("settings:adminNotebookModel.key.noEncryptionKey")}
      </SettingsNote>
    </SettingsSection>
  );
}
