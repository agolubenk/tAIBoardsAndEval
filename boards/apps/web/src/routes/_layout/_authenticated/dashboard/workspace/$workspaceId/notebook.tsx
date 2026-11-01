import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import WorkspaceLayout from "@/components/common/workspace-layout";
import { NotebookPage } from "@/components/notebook/notebook-page";
import {
  isNotebookTab,
  type NotebookTab,
} from "@/components/notebook/notebook-types";
import PageTitle from "@/components/page-title";

type NotebookSearch = { tab?: NotebookTab; thread?: string };

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/notebook",
)({
  validateSearch: (search: Record<string, unknown>): NotebookSearch => ({
    tab: isNotebookTab(search.tab) ? search.tab : undefined,
    thread:
      typeof search.thread === "string" && search.thread
        ? search.thread
        : undefined,
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation();
  const { workspaceId } = Route.useParams();
  const { tab = "chat", thread } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <>
      <PageTitle title={t("workspace:notebook.pageTitle")} />
      <WorkspaceLayout title={t("workspace:notebook.pageTitle")}>
        <div className="h-full overflow-y-auto">
          <NotebookPage
            workspaceId={workspaceId}
            tab={tab}
            threadId={thread}
            onTabChange={(next) =>
              navigate({ search: { tab: next, thread }, replace: true })
            }
            onThreadChange={(next) =>
              navigate({ search: { tab, thread: next } })
            }
          />
        </div>
      </WorkspaceLayout>
    </>
  );
}
