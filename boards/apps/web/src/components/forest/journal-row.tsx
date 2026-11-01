import { Bot, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { ForestTaskLink } from "./forest-task-link";
import type { ForestJournalEntry } from "./forest-types";

// One action on the board: who, what, on which card, and whether it was let
// through. A card that is gone keeps only its target id.
export function JournalRow({
  workspaceId,
  entry,
}: {
  workspaceId: string;
  entry: ForestJournalEntry;
}) {
  const { t } = useTranslation();
  const denied = entry.outcome === "denied";

  return (
    <li className="flex flex-col gap-1 rounded-lg border bg-card px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-1.5 font-medium text-sm">
          {entry.actorKind === "agent" ? (
            <Bot aria-hidden="true" className="size-3.5" />
          ) : (
            <User aria-hidden="true" className="size-3.5" />
          )}
          {entry.actorName}
        </span>
        <code className="text-xs">{entry.action}</code>
        {denied ? (
          <Badge variant="error">{t("workspace:forest.journal.denied")}</Badge>
        ) : null}
        <span
          className="ms-auto text-muted-foreground text-xs"
          title={formatDateTime(entry.createdAt)}
        >
          {formatRelativeTime(entry.createdAt)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        {entry.taskTitle && entry.projectId ? (
          <ForestTaskLink
            workspaceId={workspaceId}
            projectId={entry.projectId}
            taskId={entry.targetId}
            number={entry.taskNumber}
            title={entry.taskTitle}
          />
        ) : (
          <span className="break-all text-muted-foreground">
            {t("workspace:forest.journal.target", {
              type: entry.targetType,
              id: entry.targetId,
            })}
          </span>
        )}
        {entry.projectName ? (
          <Badge variant="outline">{entry.projectName}</Badge>
        ) : null}
      </div>
      {entry.detail ? (
        <p className="line-clamp-3 break-words text-muted-foreground text-xs">
          {entry.detail}
        </p>
      ) : null}
    </li>
  );
}
