import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import useGlobalSearch from "@/hooks/queries/search/use-global-search";
import type { PaletteGroup } from "./palette-filter";

// Same threshold as the search dialog; a short id like "TB-7" already passes.
const MIN_QUERY = 3;

// Cards come from the search API, which only returns what the viewer may open
// (projectAccessCondition), so the palette never lists a closed project's card.
export function useCardGroups(
  workspaceId: string | undefined,
  query: string,
): PaletteGroup[] {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const live = query.trim();
  const debounced = useDebouncedValue(live, 250);
  const q =
    live.length >= MIN_QUERY && debounced.length >= MIN_QUERY ? debounced : "";
  const { data } = useGlobalSearch({
    q,
    type: "tasks",
    workspaceId,
    limit: 8,
  });

  return useMemo<PaletteGroup[]>(() => {
    if (!q || !workspaceId) return [];
    const items = (data?.results ?? []).flatMap((result) => {
      const projectId = result.projectId;
      if (result.type !== "task" || !projectId) return [];
      const shortId =
        result.taskNumber === undefined
          ? undefined
          : result.projectSlug
            ? `${result.projectSlug.toUpperCase()}-${result.taskNumber}`
            : `#${result.taskNumber}`;
      return [
        {
          value: `card-${result.id}`,
          label: result.title,
          hint: shortId,
          onRun: () =>
            navigate({
              to: "/dashboard/workspace/$workspaceId/project/$projectId/task/$taskId",
              params: { workspaceId, projectId, taskId: result.id },
            }),
        },
      ];
    });
    return items.length > 0
      ? [
          {
            value: "cards",
            label: t("navigation:search.groups.task"),
            kind: "remote",
            items,
          },
        ]
      : [];
  }, [data?.results, navigate, q, t, workspaceId]);
}
