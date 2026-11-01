import { BotIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingsRow } from "@/components/settings/settings-row";
import { StatusBadge } from "@/components/settings/status-badge";
import { Switch } from "@/components/ui/switch";
import type listAgents from "@/fetchers/agent-identity/list-agents";
import useSetAgentEnabled from "@/hooks/mutations/agent-identity/use-set-agent-enabled";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

export type AgentItem = Awaited<ReturnType<typeof listAgents>>[number];

// One session's agent: what it is called, when it last took a key, and the
// switch that stops all its keys at once.
export function AgentRow({ agent }: { agent: AgentItem }) {
  const { t } = useTranslation();
  const { mutate, isPending } = useSetAgentEnabled();
  const enabled = agent.disabledAt === null;
  const switchId = `agent-enabled-${agent.id}`;

  return (
    <SettingsRow
      icon={<BotIcon className={enabled ? undefined : "opacity-50"} />}
      title={agent.name}
      titleClassName={enabled ? undefined : "text-muted-foreground"}
      badge={
        enabled ? (
          <StatusBadge tone={agent.keys.length ? "success" : "neutral"}>
            {t("settings:agentsPage.row.keys", { count: agent.keys.length })}
          </StatusBadge>
        ) : (
          <StatusBadge tone="destructive">
            {t("settings:agentsPage.row.disabled")}
          </StatusBadge>
        )
      }
      description={
        <span className="truncate">
          {agent.harness}
          {" · "}
          {agent.lastIssuedAt ? (
            <span title={formatDateTime(agent.lastIssuedAt)}>
              {t("settings:agentsPage.row.lastKey", {
                time: formatRelativeTime(agent.lastIssuedAt),
              })}
            </span>
          ) : (
            t("settings:agentsPage.row.noKey")
          )}
        </span>
      }
    >
      <label htmlFor={switchId} className="sr-only">
        {t("settings:agentsPage.row.toggle", { name: agent.name })}
      </label>
      <Switch
        id={switchId}
        checked={enabled}
        disabled={isPending}
        onCheckedChange={(next) => mutate({ agentId: agent.id, enabled: next })}
      />
    </SettingsRow>
  );
}
