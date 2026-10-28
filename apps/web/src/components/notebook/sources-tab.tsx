import { useTranslation } from "react-i18next";
import { ForestListState } from "@/components/forest/forest-list-state";
import useNotebookSources from "@/hooks/queries/notebook/use-notebook-sources";
import { SourceRow } from "./source-row";

// What the Mac agent has synced (R-050) and how much of it already has
// vectors for meaning-based search.
export function SourcesTab({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const sources = useNotebookSources(workspaceId);
  const list = sources.data?.sources ?? [];

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-2xl text-muted-foreground text-sm">
        {t("workspace:notebook.hints.sources")}
      </p>
      <ForestListState
        isLoading={sources.isLoading}
        isError={sources.isError}
        isEmpty={list.length === 0}
        empty={t("workspace:notebook.sources.empty")}
      >
        <p className="text-muted-foreground text-xs">
          {t("workspace:notebook.sources.model", {
            model: sources.data?.model,
          })}
        </p>
        <ul className="divide-y rounded-lg border bg-card">
          {list.map((source) => (
            <SourceRow key={`${source.kind}:${source.ref}`} source={source} />
          ))}
        </ul>
      </ForestListState>
    </div>
  );
}
