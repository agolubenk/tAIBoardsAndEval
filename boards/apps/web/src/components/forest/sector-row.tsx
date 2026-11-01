import { Axe } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatDateShort } from "@/lib/format";
import { FellDialog } from "./fell-dialog";
import { ForestTaskLink } from "./forest-task-link";
import type { ForestSector, ForestTree } from "./forest-types";

type SectorRowProps = {
  workspaceId: string;
  sector: ForestSector;
  trees: Map<string, ForestTree>;
  focused?: boolean;
};

export function SectorRow({
  workspaceId,
  sector,
  trees,
  focused = false,
}: SectorRowProps) {
  const { t } = useTranslation();
  const [felling, setFelling] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);

  // A jump from the command palette lands here: bring the sector into view and
  // move focus to it, so Tab continues from the sector's own controls.
  useEffect(() => {
    if (!focused) return;
    rowRef.current?.scrollIntoView({ block: "center" });
    rowRef.current?.focus({ preventScroll: true });
  }, [focused]);
  const visible = sector.treeIds.flatMap((id) => {
    const tree = trees.get(id);
    return tree ? [tree] : [];
  });
  const hidden = sector.treeIds.length - visible.length;

  return (
    <li
      ref={rowRef}
      tabIndex={focused ? -1 : undefined}
      aria-current={focused ? "location" : undefined}
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-card p-3 outline-none",
        focused && "ring-2 ring-ring",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 font-medium text-sm">{sector.name}</span>
        <Badge variant="outline">
          {t("workspace:forest.sectors.trees", {
            trees: sector.treeIds.length,
          })}
        </Badge>
        <Badge variant="secondary">
          {t("workspace:forest.sectors.detectedBy", {
            by: sector.detectedBy,
            date: formatDateShort(sector.createdAt),
          })}
        </Badge>
        <Button size="xs" variant="ghost" onClick={() => setFelling(true)}>
          <Axe aria-hidden="true" />
          {t("workspace:forest.fell.submit")}
        </Button>
      </div>
      <ul className="flex flex-col gap-1 pl-1">
        {visible.map((tree) => (
          <li key={tree.id} className="flex items-center gap-2 text-[13px]">
            <ForestTaskLink
              workspaceId={workspaceId}
              projectId={tree.projectId}
              taskId={tree.id}
              number={tree.number}
              title={tree.title}
            />
            <span className="shrink-0 text-muted-foreground text-xs">
              {tree.projectName}
            </span>
          </li>
        ))}
        {hidden > 0 ? (
          <li className="text-muted-foreground text-xs">
            {t("workspace:forest.sectors.hidden", { hidden })}
          </li>
        ) : null}
      </ul>
      <FellDialog
        workspaceId={workspaceId}
        target={{ kind: "sector", sectorId: sector.id }}
        subject={sector.name}
        open={felling}
        onOpenChange={setFelling}
      />
    </li>
  );
}
