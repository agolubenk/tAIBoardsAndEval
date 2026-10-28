import { Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import type { ForestMirror } from "./forest-types";

type MirrorStreakProps = {
  mirror: ForestMirror;
  canRun: boolean;
  isStarting: boolean;
  onRun: () => void;
};

// The number the transition waits on (AC-003): clean runs in a row, and what
// broke the streak before them.
export function MirrorStreak({
  mirror,
  canRun,
  isStarting,
  onRun,
}: MirrorStreakProps) {
  const { t } = useTranslation();
  const { streak } = mirror;
  const inProgress = mirror.runs[0]?.status === "running";

  return (
    <section className="flex flex-col gap-3 rounded-lg border bg-card px-4 py-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-medium text-sm">
          {t("workspace:forest.mirror.streak.title")}
        </h2>
        <p className="font-semibold text-2xl tabular-nums">{streak.runs}</p>
        <p className="text-muted-foreground text-xs">
          {streak.since
            ? t("workspace:forest.mirror.streak.since", {
                since: formatDateTime(streak.since),
                hours: Math.floor(streak.hours),
              })
            : t("workspace:forest.mirror.streak.none")}
        </p>
        {streak.brokenBy ? (
          <p className="text-muted-foreground text-xs">
            {t(`workspace:forest.mirror.streak.brokenBy.${streak.brokenBy}`, {
              hours: mirror.maxGapHours,
            })}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        {mirror.configured ? (
          <p className="text-muted-foreground text-xs">
            {t("workspace:forest.mirror.schedule", { cron: mirror.cron })}
          </p>
        ) : (
          <p className="max-w-2xl text-muted-foreground text-xs">
            {t("workspace:forest.mirror.notConfigured")}
          </p>
        )}
        {mirror.configured && canRun ? (
          <Button
            size="xs"
            variant="outline"
            disabled={isStarting || inProgress}
            onClick={onRun}
          >
            <Play aria-hidden="true" />
            {inProgress
              ? t("workspace:forest.mirror.inProgress")
              : t("workspace:forest.mirror.runNow")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
