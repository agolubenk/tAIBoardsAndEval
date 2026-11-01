import { Bot, User, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import useCardWorkers from "@/hooks/queries/forest/use-card-workers";
import { cn } from "@/lib/cn";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cardWorkerLine } from "./card-worker-line";

type TaskCardWorkerProps = {
  workspaceId: string;
  projectId: string;
  taskId: string;
};

// Which session or agent is on the card (R-010, R-026, R-037): the lease
// holder now, else the session whose working state names the card, plus who
// the card's fields say did the work.
export function TaskCardWorker({
  workspaceId,
  projectId,
  taskId,
}: TaskCardWorkerProps) {
  const { t } = useTranslation();
  const { data } = useCardWorkers(workspaceId, projectId);
  const line = cardWorkerLine(data?.get(taskId));
  if (!line) return null;

  const Icon =
    line.source === "executor" ? Wrench : line.kind === "agent" ? Bot : User;
  const text =
    line.source === "holder"
      ? t("tasks:card.worker.holding", { name: line.name })
      : line.source === "session"
        ? t("tasks:card.worker.session", { name: line.name, step: line.step })
        : t("tasks:card.worker.executor", { name: line.name });
  const title = !line.at
    ? undefined
    : line.source === "holder"
      ? t("tasks:card.worker.holdingUntil", { time: formatDateTime(line.at) })
      : t("tasks:card.worker.sessionAt", { time: formatRelativeTime(line.at) });

  return (
    <div
      className={cn(
        "mb-2.5 flex min-w-0 items-center gap-1.5 text-[11px]",
        line.live ? "text-foreground/80" : "text-muted-foreground",
      )}
      aria-label={t("tasks:card.worker.label")}
      title={title}
    >
      {line.live && (
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full bg-success"
        />
      )}
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{text}</span>
      {line.executor && (
        <span className="shrink-0 truncate text-muted-foreground">
          · {t("tasks:card.worker.executor", { name: line.executor })}
        </span>
      )}
    </div>
  );
}
