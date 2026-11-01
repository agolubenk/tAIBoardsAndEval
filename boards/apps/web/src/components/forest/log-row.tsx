import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { ForestLogSummary } from "./forest-types";
import { LogSeeds } from "./log-seeds";

type LogRowProps = {
  workspaceId: string;
  log: ForestLogSummary;
  selected: ReadonlySet<string>;
  onToggle: (seedId: string, checked: boolean) => void;
};

export function LogRow({ workspaceId, log, selected, onToggle }: LogRowProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <li className="rounded-lg border bg-card">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2 py-2 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-medium text-sm">
          {log.taskNumber !== null ? (
            <span className="mr-1.5 text-muted-foreground tabular-nums">
              #{log.taskNumber}
            </span>
          ) : null}
          {log.title}
        </span>
        <Badge variant="outline">{log.sourceProjectName}</Badge>
        <Badge variant="secondary">{log.finalStatus}</Badge>
        <span
          className="text-muted-foreground text-xs"
          title={formatDateTime(log.felledAt)}
        >
          {t("workspace:forest.logs.felledAt", {
            time: formatRelativeTime(log.felledAt),
          })}
        </span>
      </button>
      {open ? (
        <div className="border-t px-4 py-2.5">
          <LogSeeds
            workspaceId={workspaceId}
            logId={log.id}
            selected={selected}
            onToggle={onToggle}
          />
        </div>
      ) : null}
    </li>
  );
}
