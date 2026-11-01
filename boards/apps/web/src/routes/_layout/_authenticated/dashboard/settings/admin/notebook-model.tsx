import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { NotebookModelPage } from "@/components/admin/notebook-model/notebook-model-page";
import PageTitle from "@/components/page-title";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/settings/admin/notebook-model",
)({
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation();

  return (
    <>
      <PageTitle title={t("settings:adminNotebookModel.title")} />
      <NotebookModelPage />
    </>
  );
}
