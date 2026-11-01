import { BotIcon, LockIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsEmpty } from "@/components/settings/settings-empty";
import { SettingsNote } from "@/components/settings/settings-note";
import { SettingsPage } from "@/components/settings/settings-page";
import { SettingsRowsSkeleton } from "@/components/settings/settings-rows-skeleton";
import { SettingsSection } from "@/components/settings/settings-section";
import useAgents from "@/hooks/queries/agent-identity/use-agents";
import { AgentRow } from "./agent-row";
import { ModelSection } from "./model-section";
import { ToolSetsSection } from "./tool-sets-section";

// d-tb-forest-in-cards: one place for the agents that work under their own
// names (R-010), the MCP tool sets (R-034) and the model with its budget.
export function AgentsSettings() {
  const { t } = useTranslation();
  const agentsQuery = useAgents();
  const agents = agentsQuery.data ?? [];

  const renderAgents = () => {
    if (agentsQuery.isPending) {
      return <SettingsRowsSkeleton rows={2} withDescription />;
    }
    if (agentsQuery.isError) {
      return (
        <p
          role="alert"
          className="px-4 py-3.5 text-destructive-foreground text-sm"
        >
          {t("settings:agentsPage.loadError")}
        </p>
      );
    }
    if (agents.length === 0) {
      return (
        <SettingsEmpty
          icon={<BotIcon />}
          title={t("settings:agentsPage.emptyTitle")}
          description={t("settings:agentsPage.emptyDescription")}
        />
      );
    }
    return agents.map((agent) => <AgentRow key={agent.id} agent={agent} />);
  };

  return (
    <SettingsPage
      title={t("settings:agentsPage.title")}
      description={t("settings:agentsPage.subtitle")}
    >
      <SettingsSection title={t("settings:agentsPage.agentsTitle")}>
        <SettingsCard>{renderAgents()}</SettingsCard>
        <SettingsNote icon={LockIcon}>
          {t("settings:agentsPage.agentsNote")}
        </SettingsNote>
      </SettingsSection>
      <ToolSetsSection />
      <ModelSection />
    </SettingsPage>
  );
}
