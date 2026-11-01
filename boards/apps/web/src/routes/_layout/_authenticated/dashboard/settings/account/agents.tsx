import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import PageTitle from "@/components/page-title";
import { AgentsSettings } from "@/components/settings/agents/agents-settings";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/settings/account/agents",
)({
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation();

  return (
    <>
      <PageTitle title={t("settings:agentsPage.pageTitle")} />
      <AgentsSettings />
    </>
  );
}
