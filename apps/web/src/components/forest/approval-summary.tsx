import { useTranslation } from "react-i18next";

type ApprovalSummaryProps = {
  action: string;
  params: Record<string, string> | null;
};

// What the agent asks the owner to allow, in words.
export function ApprovalSummary({ action, params }: ApprovalSummaryProps) {
  const { t } = useTranslation();
  switch (action) {
    case "close_task":
      return (
        <>
          {t("workspace:forest.approvals.action.closeTask", {
            status: params?.status ?? "—",
          })}
        </>
      );
    case "set_priority":
      return (
        <>
          {t("workspace:forest.approvals.action.setPriority", {
            priority: params?.priority ?? "—",
          })}
        </>
      );
    case "fell_tree":
      return <>{t("workspace:forest.approvals.action.fellTree")}</>;
    case "fell_sector":
      return <>{t("workspace:forest.approvals.action.fellSector")}</>;
    default:
      return <>{action}</>;
  }
}
