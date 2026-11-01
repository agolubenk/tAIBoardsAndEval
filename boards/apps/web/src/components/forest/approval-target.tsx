import { useTranslation } from "react-i18next";
import { ForestTaskLink } from "./forest-task-link";
import type { ForestApproval } from "./forest-types";

type ApprovalTargetProps = {
  workspaceId: string;
  approval: Pick<ForestApproval, "targetType" | "targetId" | "target">;
};

// The card or sector a request is about; unnamed when the caller cannot open it.
export function ApprovalTarget({ workspaceId, approval }: ApprovalTargetProps) {
  const { t } = useTranslation();
  const { target } = approval;

  if (!target) {
    return (
      <p className="text-muted-foreground text-xs">
        {t("workspace:forest.approvals.targetUnknown")}
      </p>
    );
  }
  if (approval.targetType === "task" && target.projectId) {
    return (
      <p className="flex min-w-0 items-center gap-2 text-[13px]">
        <ForestTaskLink
          workspaceId={workspaceId}
          projectId={target.projectId}
          taskId={approval.targetId}
          number={target.number}
          title={target.title}
        />
        <span className="shrink-0 text-muted-foreground text-xs">
          {target.projectName}
        </span>
      </p>
    );
  }
  return (
    <p className="text-[13px]">
      {t("workspace:forest.approvals.sector", { name: target.title })}
    </p>
  );
}
