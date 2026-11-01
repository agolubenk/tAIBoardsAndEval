import { createHash } from "node:crypto";

export const APPROVAL_ACTIONS = [
  "fell_tree",
  "fell_sector",
  "close_task",
  "reopen_task",
  "set_priority",
] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

// Task actions an agent needs the owner's «да» for (R-022); felling has its
// own route and needs task:delete.
export const TASK_APPROVAL_ACTIONS = [
  "close_task",
  "reopen_task",
  "set_priority",
] as const;
export type TaskApprovalAction = (typeof TASK_APPROVAL_ACTIONS)[number];
export type FellAction = Exclude<ApprovalAction, TaskApprovalAction>;

export function isTaskApprovalAction(
  action: ApprovalAction,
): action is TaskApprovalAction {
  return (TASK_APPROVAL_ACTIONS as readonly string[]).includes(action);
}

export const APPROVAL_TTL_HOURS = 24;

// An approval covers exactly what the owner saw: for a felling the sorted
// tree ids, for a task action the one value (closing or reopening status, new
// priority).
// A changed sector, tree list or value needs a fresh «да».
export function approvalParamsHash(
  action: ApprovalAction,
  targetId: string,
  items: readonly string[],
): string {
  const canonical = JSON.stringify({
    action,
    targetId,
    // Key kept from the felling-only version so stored hashes still match.
    treeIds: [...new Set(items)].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
