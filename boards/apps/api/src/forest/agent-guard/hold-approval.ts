import { and, eq } from "drizzle-orm";
import db from "../../database";
import { ownerApprovalTable } from "../../database/forest-schema";
import {
  approvalParamsHash,
  type TaskApprovalAction,
} from "../approval/approval-params";
import { consumeApproval } from "../approval/consume-approval";

// The upstream handler runs in its own transaction, so the «да» is spent
// before it and handed back if the write fails: one approval, one write.
export async function holdApproval(input: {
  approvalId: string;
  workspaceId: string;
  action: TaskApprovalAction;
  taskId: string;
  value: string;
}) {
  return db.transaction((tx) =>
    consumeApproval(tx, {
      approvalId: input.approvalId,
      workspaceId: input.workspaceId,
      action: input.action,
      paramsHash: approvalParamsHash(input.action, input.taskId, [input.value]),
    }),
  );
}

export async function releaseApproval(approvalId: string) {
  await db
    .update(ownerApprovalTable)
    .set({ status: "approved", consumedAt: null })
    .where(
      and(
        eq(ownerApprovalTable.id, approvalId),
        eq(ownerApprovalTable.status, "consumed"),
      ),
    );
}
