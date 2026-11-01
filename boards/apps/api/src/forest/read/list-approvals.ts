import { and, desc, eq, gt, lt, or } from "drizzle-orm";
import db from "../../database";
import { ownerApprovalTable } from "../../database/forest-schema";
import { decodeCursor, encodeCursor, pageSize } from "./page-cursor";

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "consumed",
] as const;

// Pending means still answerable: an expired request drops out of the list.
export async function listApprovals({
  workspaceId,
  status,
  cursor,
  take,
}: {
  workspaceId: string;
  status?: (typeof APPROVAL_STATUSES)[number];
  cursor?: string;
  take?: number;
}) {
  const limit = pageSize(take);
  const after = decodeCursor(cursor);
  const rows = await db
    .select()
    .from(ownerApprovalTable)
    .where(
      and(
        eq(ownerApprovalTable.workspaceId, workspaceId),
        status ? eq(ownerApprovalTable.status, status) : undefined,
        status === "pending"
          ? gt(ownerApprovalTable.expiresAt, new Date())
          : undefined,
        after
          ? or(
              lt(ownerApprovalTable.createdAt, after.at),
              and(
                eq(ownerApprovalTable.createdAt, after.at),
                lt(ownerApprovalTable.id, after.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(ownerApprovalTable.createdAt), desc(ownerApprovalTable.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ at: last.createdAt, id: last.id })
        : null,
  };
}
