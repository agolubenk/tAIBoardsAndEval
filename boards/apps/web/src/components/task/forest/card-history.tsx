import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import useRollbackCard from "@/hooks/mutations/forest/use-rollback-card";
import useCardHistory from "@/hooks/queries/forest/use-card-history";
import { CardHistoryItem } from "./card-history-item";
import { useActorLabel } from "./use-actor-label";
import { useHistoryFieldLabels } from "./use-history-field-labels";

const SHOWN = 5;

// Edits of the card, newest first, each with an undo (R-023).
export function CardHistory({
  workspaceId,
  taskId,
}: {
  workspaceId: string;
  taskId: string;
}) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useCardHistory(workspaceId, taskId);
  const rollback = useRollbackCard(workspaceId, taskId);
  const fieldLabels = useHistoryFieldLabels();
  const actorLabel = useActorLabel();
  const [showAll, setShowAll] = useState(false);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 px-2 py-1">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <p className="px-2 py-1 text-destructive-foreground text-xs">
        {t("tasks:card.history.loadError")}
      </p>
    );
  }
  if (!data.entries.length) {
    return (
      <p className="px-2 py-1 text-muted-foreground text-xs">
        {t("tasks:card.history.empty")}
      </p>
    );
  }

  const entries = showAll ? data.entries : data.entries.slice(0, SHOWN);
  return (
    <>
      <ul className="flex flex-col gap-0.5">
        {entries.map((entry) => (
          <CardHistoryItem
            key={entry.id}
            entry={entry}
            fieldLabels={fieldLabels}
            actorLabel={actorLabel(entry.actorId)}
            rollingBack={rollback.isPending}
            onRollback={() =>
              rollback.mutate({ workspaceId, taskId, historyId: entry.id })
            }
          />
        ))}
      </ul>
      {data.entries.length > SHOWN ? (
        <button
          type="button"
          className="self-start px-2 py-1 text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll
            ? t("tasks:card.showLess")
            : t("tasks:card.showAll", { total: data.entries.length })}
        </button>
      ) : null}
    </>
  );
}
