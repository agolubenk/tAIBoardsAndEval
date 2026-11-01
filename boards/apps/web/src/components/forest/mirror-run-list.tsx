import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import type { ForestMirrorRun } from "./forest-types";
import { MIRROR_STATUS_VARIANT } from "./mirror-status";

export function MirrorRunList({ runs }: { runs: ForestMirrorRun[] }) {
  const { t } = useTranslation();

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-medium text-sm">
        {t("workspace:forest.mirror.runs.title")}
      </h2>
      <ul className="flex flex-col gap-1.5">
        {runs.map((run) => (
          <li
            key={run.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card px-3 py-2"
          >
            <Badge variant={MIRROR_STATUS_VARIANT[run.status]}>
              {t(`workspace:forest.mirror.status.${run.status}`)}
            </Badge>
            <span
              className="flex-1 text-sm"
              title={formatDateTime(run.startedAt)}
            >
              {formatRelativeTime(run.startedAt)}
            </span>
            {run.discrepancyCount > 0 ? (
              <span className="text-muted-foreground text-xs tabular-nums">
                {t("workspace:forest.mirror.runs.discrepancies", {
                  count: run.discrepancyCount,
                })}
              </span>
            ) : null}
            <Badge variant="outline">
              {t(`workspace:forest.mirror.trigger.${run.trigger}`)}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}
