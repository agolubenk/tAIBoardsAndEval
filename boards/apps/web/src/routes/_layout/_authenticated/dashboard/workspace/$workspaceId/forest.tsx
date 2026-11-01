import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import WorkspaceLayout from "@/components/common/workspace-layout";
import { ForestPage } from "@/components/forest/forest-page";
import { type ForestTab, isForestTab } from "@/components/forest/forest-types";
import PageTitle from "@/components/page-title";

type ForestSearch = { tab?: ForestTab };

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/forest",
)({
  validateSearch: (search: Record<string, unknown>): ForestSearch => ({
    tab: isForestTab(search.tab) ? search.tab : undefined,
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation();
  const { workspaceId } = Route.useParams();
  const { tab = "pulse" } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <>
      <PageTitle title={t("workspace:forest.pageTitle")} />
      <WorkspaceLayout title={t("workspace:forest.pageTitle")}>
        <div className="h-full overflow-y-auto">
          <ForestPage
            workspaceId={workspaceId}
            tab={tab}
            onTabChange={(next) =>
              navigate({ search: { tab: next }, replace: true })
            }
          />
        </div>
      </WorkspaceLayout>
    </>
  );
}
