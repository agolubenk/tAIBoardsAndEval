import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { taskLeaseTable } from "../../database/forest-schema";
import { taskTable } from "../../database/schema";
import type { ForestActor } from "../actor";
import { findFelledLog } from "../find-felled-log";
import { ForestError } from "../forest-error";
import { decideAcquire } from "./decide-acquire";

export const LEASE_DEFAULT_SECONDS = 300;
export const LEASE_MAX_SECONDS = 1800;

export type LeaseGrant = {
  taskId: string;
  fencingToken: number;
  expiresAt: Date;
  revision: number;
};

export async function acquireLease({
  taskId,
  actor,
  groupKey = null,
  ttlSeconds = LEASE_DEFAULT_SECONDS,
}: {
  taskId: string;
  actor: ForestActor;
  groupKey?: string | null;
  ttlSeconds?: number;
}): Promise<LeaseGrant> {
  const ttl = Math.min(Math.max(ttlSeconds, 30), LEASE_MAX_SECONDS);

  return db.transaction(async (tx) => {
    const [task] = await tx
      .select({ id: taskTable.id, revision: taskTable.revision })
      .from(taskTable)
      .where(eq(taskTable.id, taskId))
      .for("update");
    if (!task) {
      if (await findFelledLog(taskId, tx)) {
        throw new ForestError(
          "felled",
          "the tree was felled; logs do not grow",
        );
      }
      throw new HTTPException(404, { message: "Task not found" });
    }

    const [existing] = await tx
      .select()
      .from(taskLeaseTable)
      .where(eq(taskLeaseTable.taskId, taskId));
    const now = new Date();
    const decision = decideAcquire(
      existing ?? null,
      { holderId: actor.id, groupKey },
      now,
    );
    if (decision.kind === "conflict") {
      throw new ForestError(
        "lease_conflict",
        `held by ${decision.holderName} until ${decision.expiresAt.toISOString()}`,
      );
    }

    const expiresAt = new Date(now.getTime() + ttl * 1000);
    if (decision.kind === "insert") {
      await tx.insert(taskLeaseTable).values({
        taskId,
        holderId: actor.id,
        holderName: actor.name,
        holderKind: actor.kind,
        groupKey,
        fencingToken: decision.fencingToken,
        acquiredAt: now,
        expiresAt,
      });
    } else if (decision.kind === "extend") {
      await tx
        .update(taskLeaseTable)
        .set({ expiresAt })
        .where(eq(taskLeaseTable.taskId, taskId));
    } else {
      await tx
        .update(taskLeaseTable)
        .set({
          holderId: actor.id,
          holderName: actor.name,
          holderKind: actor.kind,
          groupKey,
          fencingToken: decision.fencingToken,
          acquiredAt: now,
          expiresAt,
        })
        .where(eq(taskLeaseTable.taskId, taskId));
    }

    return {
      taskId,
      fencingToken: decision.fencingToken,
      expiresAt,
      revision: task.revision,
    };
  });
}
