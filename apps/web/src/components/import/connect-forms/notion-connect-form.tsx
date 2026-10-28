import { useTranslation } from "react-i18next";
import { ConnectFieldRow } from "@/components/import/connect-forms/connect-field-row";
import type { ConnectFormProps } from "@/components/import/connect-forms/connect-form-props";
import { ConnectHelpSteps } from "@/components/import/connect-forms/connect-help-steps";
import { fieldDescribedBy } from "@/components/import/connect-forms/field-ids";
import { SecretInput } from "@/components/import/connect-forms/secret-input";
import { Textarea } from "@/components/ui/textarea";

const TOKEN_ID = "import-notion-token";
const DATABASES_ID = "import-notion-databases";

export function NotionConnectForm({
  values,
  onChange,
  error,
}: ConnectFormProps) {
  const { t } = useTranslation();
  const tokenLabel = t("settings:workspaceImport.notion.tokenLabel");

  return (
    <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      <ConnectFieldRow
        id={TOKEN_ID}
        labelFor={TOKEN_ID}
        label={tokenLabel}
        description={t("settings:workspaceImport.notion.tokenDescription")}
        error={error}
      >
        <SecretInput
          id={TOKEN_ID}
          label={tokenLabel}
          value={values.token}
          onValueChange={(token) => onChange({ token })}
          placeholder="ntn_..."
          invalid={Boolean(error)}
        />
      </ConnectFieldRow>
      <ConnectFieldRow
        id={DATABASES_ID}
        labelFor={DATABASES_ID}
        label={t("settings:workspaceImport.notion.databasesLabel")}
        description={t("settings:workspaceImport.notion.databasesDescription")}
      >
        <Textarea
          id={DATABASES_ID}
          value={values.databaseIds}
          onChange={(event) => onChange({ databaseIds: event.target.value })}
          placeholder="https://www.notion.so/…"
          rows={3}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-describedby={fieldDescribedBy(DATABASES_ID, false)}
        />
      </ConnectFieldRow>
      <ConnectHelpSteps
        href="https://www.notion.so/profile/integrations"
        linkLabel={t("settings:workspaceImport.notion.openSettings")}
        steps={[
          t("settings:workspaceImport.notion.stepCreate"),
          t("settings:workspaceImport.notion.stepShare"),
          t("settings:workspaceImport.notion.stepPaste"),
        ]}
      />
    </div>
  );
}
