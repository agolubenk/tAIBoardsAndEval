import { useTranslation } from "react-i18next";

// Names for the fields a history row records: kaneo's task fields and the
// card fields (R-023, R-024).
export function useHistoryFieldLabels(): Record<string, string> {
  const { t } = useTranslation();
  return {
    title: t("tasks:card.historyField.title"),
    description: t("tasks:card.historyField.description"),
    status: t("tasks:card.historyField.status"),
    columnId: t("tasks:card.historyField.column"),
    priority: t("tasks:card.historyField.priority"),
    assigneeId: t("tasks:card.historyField.assignee"),
    startDate: t("tasks:card.historyField.startDate"),
    dueDate: t("tasks:card.historyField.dueDate"),
    kind: t("tasks:card.fields.kind"),
    severity: t("tasks:card.fields.severity"),
    backlogId: t("tasks:card.fields.backlogId"),
    halfBaked: t("tasks:card.fields.halfBaked"),
    report: t("tasks:card.fields.report"),
    executor: t("tasks:card.fields.executor"),
    branch: t("tasks:card.fields.branch"),
    pullRequests: t("tasks:card.fields.pullRequests"),
    files: t("tasks:card.fields.files"),
    tokens: t("tasks:card.fields.tokens"),
    costUsd: t("tasks:card.fields.cost"),
    contextPack: t("tasks:card.fields.contextPack"),
  };
}
