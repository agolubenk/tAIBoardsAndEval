import { and, eq, gt } from "drizzle-orm";
import type { Tx } from "../tx";
import { ownerApprovalTable } from "../../database/forest-schema";
import { ForestError } from "../forest-error";
import type { ApprovalAction } from "./approval-params";

// Spends an approved «да» inside the action's own transaction: if the action
// rolls back, the approval stays unspent.
export async function consumeApproval(
  tx: Tx,
  {
    approvalId,
    workspaceId,
    action,
    paramsHash,
  }: {
    approvalId: string;
    workspaceId: string;
    action: ApprovalAction;
    paramsHash: string;
  },
) {
  const [consumed] = await tx
    .update(ownerApprovalTable)
    .set({ status: "consumed", consumedAt: new Date() })
    .where(
      and(
        eq(ownerApprovalTable.id, approvalId),
        eq(ownerApprovalTable.workspaceId, workspaceId),
        eq(ownerApprovalTable.action, action),
        eq(ownerApprovalTable.paramsHash, paramsHash),
        eq(ownerApprovalTable.status, "approved"),
        gt(ownerApprovalTable.expiresAt, new Date()),
      ),
    )
    .returning({ id: ownerApprovalTable.id });
  if (!consumed) {
    throw new ForestError(
      "approval_required",
      "no approved, unspent owner approval matches this action and its parameters",
    );
  }
  return consumed.id;
}
