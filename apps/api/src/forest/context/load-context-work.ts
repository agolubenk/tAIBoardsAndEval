import { and, desc, eq, gt } from "drizzle-orm";
import db from "../../database";
import {
  ownerApprovalTable,
  taskLeaseTable,
} from "../../database/forest-schema";

// Who works on the card now. The fencing token stays out: it is the
// holder's proof, not something a reader needs.
export async function loadContextLease(taskId: string, now: Date) {
  const [lease] = await db
    .select({
      holderName: taskLeaseTable.holderName,
      holderKind: taskLeaseTable.holderKind,
      expiresAt: taskLeaseTable.expiresAt,
    })
    .from(taskLeaseTable)
    .where(
      and(eq(taskLeaseTable.taskId, taskId), gt(taskLeaseTable.expiresAt, now)),
    )
    .limit(1);
  return lease ?? null;
}

// Requests for the owner's «да» on this card that can still be answered.
export async function loadContextApprovals(
  workspaceId: string,
  taskId: string,
  now: Date,
  take: number,
) {
  return db
    .select({
      id: ownerApprovalTable.id,
      action: ownerApprovalTable.action,
      params: ownerApprovalTable.params,
      reason: ownerApprovalTable.reason,
      requestedByName: ownerApprovalTable.requestedByName,
      createdAt: ownerApprovalTable.createdAt,
      expiresAt: ownerApprovalTable.expiresAt,
    })
    .from(ownerApprovalTable)
    .where(
      and(
        eq(ownerApprovalTable.workspaceId, workspaceId),
        eq(ownerApprovalTable.targetType, "task"),
        eq(ownerApprovalTable.targetId, taskId),
        eq(ownerApprovalTable.status, "pending"),
        gt(ownerApprovalTable.expiresAt, now),
      ),
    )
    .orderBy(desc(ownerApprovalTable.createdAt))
    .limit(take);
}
