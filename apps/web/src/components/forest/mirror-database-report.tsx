import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { ForestMirrorDatabase } from "./forest-types";

// One Notion database in the newest finished run: what was read, the totals
// on both sides, and every discrepancy the report kept.
export function MirrorDatabaseReport({
  database,
}: {
  database: ForestMirrorDatabase;
}) {
  const { t } = useTranslation();
  const listed = database.discrepancies.length;

  return (
    <section className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-medium text-sm">{database.name}</h3>
        {database.totals ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            {t("workspace:forest.mirror.report.totals", database.totals)}
          </span>
        ) : null}
        <span className="text-muted-foreground text-xs tabular-nums">
          {t("workspace:forest.mirror.report.read", database.read)}
        </span>
      </div>
      {database.error ? (
        <p role="alert" className="text-destructive-foreground text-sm">
          {database.error}
        </p>
      ) : database.discrepancyCount === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("workspace:forest.mirror.report.agree")}
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y">
            {database.discrepancies.map((item) => (
              <li
                key={`${item.pageId}:${item.kind}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5"
              >
                <Badge variant="warning">
                  {t(`workspace:forest.mirror.kind.${item.kind}`)}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {item.title}
                </span>
                <span className="text-muted-foreground text-xs">
                  {item.detail}
                </span>
              </li>
            ))}
          </ul>
          {listed < database.discrepancyCount ? (
            <p className="text-muted-foreground text-xs">
              {t("workspace:forest.mirror.report.more", {
                shown: listed,
                count: database.discrepancyCount,
              })}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
