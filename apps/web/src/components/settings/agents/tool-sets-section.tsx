import { WrenchIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsNote } from "@/components/settings/settings-note";
import { SettingsRowsSkeleton } from "@/components/settings/settings-rows-skeleton";
import { SettingsSection } from "@/components/settings/settings-section";
import useToolSets from "@/hooks/queries/agent-identity/use-tool-sets";

// R-034: what an MCP session of each role sees in its tool list.
export function ToolSetsSection() {
  const { t } = useTranslation();
  const { data, isPending, isError } = useToolSets();

  const renderRoles = () => {
    if (isPending) return <SettingsRowsSkeleton rows={3} />;
    if (isError || !data) {
      return (
        <p
          role="alert"
          className="px-4 py-3.5 text-destructive-foreground text-sm"
        >
          {t("settings:agentsPage.tools.loadError")}
        </p>
      );
    }
    return data.roles.map(({ role, tools }) => (
      <details key={role} className="group px-4 py-3">
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded-sm text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <WrenchIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="font-medium font-mono">{role}</span>
          <span className="text-muted-foreground text-xs">
            {t("settings:agentsPage.tools.count", { count: tools.length })}
          </span>
        </summary>
        <ul className="mt-2 flex flex-wrap gap-1 pl-7">
          {tools.map((tool) => (
            <li
              key={tool}
              className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs"
            >
              {tool}
            </li>
          ))}
        </ul>
      </details>
    ));
  };

  return (
    <SettingsSection
      title={t("settings:agentsPage.tools.title")}
      description={t("settings:agentsPage.tools.description")}
    >
      <SettingsCard>{renderRoles()}</SettingsCard>
      {data ? (
        <SettingsNote icon={WrenchIcon}>
          {t("settings:agentsPage.tools.note", {
            header: data.header,
            extra: data.extraMax,
          })}
        </SettingsNote>
      ) : null}
    </SettingsSection>
  );
}
