import { useTranslation } from "react-i18next";
import type { ForestTab } from "./forest-types";
import { PulseDenied } from "./pulse-denied";
import { PulseFires } from "./pulse-fires";
import { PulseWaiting } from "./pulse-waiting";

// R-090: «what is on fire, what waits for you» on one screen.
export function PulseTab({
  workspaceId,
  onTabChange,
}: {
  workspaceId: string;
  onTabChange: (tab: ForestTab) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-2xl text-muted-foreground text-sm">
        {t("workspace:forest.hints.pulse")}
      </p>
      <PulseWaiting workspaceId={workspaceId} onTabChange={onTabChange} />
      <PulseFires workspaceId={workspaceId} />
      <PulseDenied workspaceId={workspaceId} onTabChange={onTabChange} />
    </div>
  );
}
