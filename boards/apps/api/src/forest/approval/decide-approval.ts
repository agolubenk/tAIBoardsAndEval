import { and, eq, gt } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { ownerApprovalTable } from "../../database/forest-schema";
import type { ForestActor } from "../actor";
import { ForestError } from "../forest-error";
import { writeJournal } from "../journal";

// N-011: a decision is accepted only from the owner's session. An agent key
// that tries to answer its own request is refused and the attempt journaled.
export async function decideApproval({
  approvalId,
  workspaceId,
  decision,
  actor,
}: {
  approvalId: string;
  workspaceId: string;
  decision: "approved" | "rejected";
  actor: ForestActor;
}) {
  if (actor.kind !== "owner-ui") {
    await writeJournal({
      workspaceId,
      actor,
      action: "approval.decide",
      targetType: "approval",
      targetId: approvalId,
      outcome: "denied",
      detail: "owner session required (N-011)",
    });
    throw new ForestError(
      "owner_session_required",
      "only the owner's own session can answer an approval",
    );
  }

  return db.transaction(async (tx) => {
    const [decided] = await tx
      .update(ownerApprovalTable)
      .set({
        status: decision,
        decidedByUserId: actor.userId,
        decidedVia: "ui",
        decidedAt: new Date(),
      })
      .where(
        and(
          eq(ownerApprovalTable.id, approvalId),
          eq(ownerApprovalTable.workspaceId, workspaceId),
          eq(ownerApprovalTable.status, "pending"),
          gt(ownerApprovalTable.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!decided) {
      throw new HTTPException(409, {
        message: "Approval is not pending (answered, consumed or expired)",
      });
    }
    await writeJournal(
      {
        workspaceId,
        actor,
        action: `approval.${decision}`,
        targetType: decided.targetType,
        targetId: decided.targetId,
        outcome: "allowed",
        detail: `approval ${approvalId}`,
      },
      tx,
    );
    return decided;
  });
}
