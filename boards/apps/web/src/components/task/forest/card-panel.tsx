import { Pencil } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApprovalItem } from "@/components/forest/approval-item";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import useCardContext from "@/hooks/queries/forest/use-card-context";
import { cn } from "@/lib/cn";
import { CardAgentRows } from "./card-agent-rows";
import { CardHistory } from "./card-history";
import { CardLeaseRows } from "./card-lease-rows";
import { CardMemory } from "./card-memory";
import { CardMetaDialog } from "./card-meta-dialog";
import { CardNotionRows } from "./card-notion-rows";
import { CardPlaceRows } from "./card-place-rows";
import { CardSection } from "./card-section";

type CardPanelProps = {
  workspaceId: string;
  taskId: string;
  className?: string;
};

// The t-boards side of a card: what waits for the owner's «да», where it
// sits in the forest, who works on it, the Notion and agent fields, its edits
// with undo and what agents remembered about it.
export function CardPanel({ workspaceId, taskId, className }: CardPanelProps) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useCardContext(workspaceId, taskId);
  const [editing, setEditing] = useState(false);

  if (isLoading) {
    return (
      <div className={cn("flex flex-col gap-2 px-2 pt-3", className)}>
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <p className={cn("px-2 pt-3 text-muted-foreground text-xs", className)}>
        {t("tasks:card.loadError")}
      </p>
    );
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {data.approvals.length ? (
        <CardSection
          title={t("tasks:card.sections.approvals")}
          count={data.approvals.length}
        >
          <div className="flex flex-col gap-2 px-1 pb-1">
            {data.approvals.map((approval) => (
              <ApprovalItem
                key={approval.id}
                workspaceId={workspaceId}
                approval={approval}
              />
            ))}
          </div>
        </CardSection>
      ) : null}

      <CardSection title={t("tasks:card.sections.place")}>
        <CardPlaceRows workspaceId={workspaceId} taskId={taskId} />
      </CardSection>

      <CardSection title={t("tasks:card.sections.lease")}>
        <CardLeaseRows lease={data.lease} />
      </CardSection>

      <CardSection
        title={t("tasks:card.sections.notion")}
        action={
          <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
            <Pencil aria-hidden="true" />
            {t("tasks:card.edit.open")}
          </Button>
        }
      >
        <CardNotionRows meta={data.meta} />
      </CardSection>

      <CardSection title={t("tasks:card.sections.agent")}>
        <CardAgentRows meta={data.meta} />
      </CardSection>

      <CardSection title={t("tasks:card.sections.history")}>
        <CardHistory workspaceId={workspaceId} taskId={taskId} />
      </CardSection>

      <CardSection title={t("tasks:card.sections.memory")}>
        <CardMemory workspaceId={workspaceId} taskId={taskId} />
      </CardSection>

      <CardMetaDialog
        workspaceId={workspaceId}
        taskId={taskId}
        meta={data.meta}
        open={editing}
        onOpenChange={setEditing}
      />
    </div>
  );
}
