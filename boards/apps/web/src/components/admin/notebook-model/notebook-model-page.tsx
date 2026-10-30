import { useTranslation } from "react-i18next";
import { SettingsPage } from "@/components/settings/settings-page";
import { SettingsRowsSkeleton } from "@/components/settings/settings-rows-skeleton";
import { Button } from "@/components/ui/button";
import useNotebookModel from "@/hooks/queries/admin/use-notebook-model";
import { ModelFieldsSection } from "./model-fields-section";
import { ModelKeySection } from "./model-key-section";
import { ModelUsageSection } from "./model-usage-section";

export function NotebookModelPage() {
  const { t } = useTranslation();
  const { data, isPending, isError, refetch } = useNotebookModel();

  const renderBody = () => {
    if (isPending) return <SettingsRowsSkeleton rows={4} />;
    if (isError || !data) {
      return (
        <div role="alert" className="space-y-3 text-sm">
          <p className="text-destructive-foreground">
            {t("settings:adminNotebookModel.loadError")}
          </p>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            {t("settings:adminNotebookModel.retry")}
          </Button>
        </div>
      );
    }
    return (
      <>
        <ModelFieldsSection settings={data} />
        <ModelKeySection settings={data} />
        <ModelUsageSection settings={data} />
      </>
    );
  };

  return (
    <SettingsPage
      title={t("settings:adminNotebookModel.title")}
      description={t("settings:adminNotebookModel.subtitle")}
    >
      {renderBody()}
    </SettingsPage>
  );
}
