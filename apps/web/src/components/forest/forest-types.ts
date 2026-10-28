import type listApprovals from "@/fetchers/forest/list-approvals";
import type listLeases from "@/fetchers/forest/list-leases";
import type listLogs from "@/fetchers/forest/list-logs";
import type listSectors from "@/fetchers/forest/list-sectors";
import type listTrees from "@/fetchers/forest/list-trees";

export type ForestTree = Awaited<ReturnType<typeof listTrees>>["trees"][number];
export type ForestSector = Awaited<ReturnType<typeof listSectors>>[number];
export type ForestLogSummary = Awaited<
  ReturnType<typeof listLogs>
>["items"][number];
export type ForestApproval = Awaited<
  ReturnType<typeof listApprovals>
>["items"][number];
export type ForestLease = Awaited<ReturnType<typeof listLeases>>[number];

export const FOREST_TABS = [
  "trees",
  "sectors",
  "logs",
  "approvals",
  "leases",
] as const;
export type ForestTab = (typeof FOREST_TABS)[number];

export function isForestTab(value: unknown): value is ForestTab {
  return (FOREST_TABS as readonly unknown[]).includes(value);
}
