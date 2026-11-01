import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { cardMetaTable } from "../../database/forest-schema";
import type { CardMetaPatch } from "./card-patch";

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown) {
  const cause = (error as { cause?: { code?: string } })?.cause;
  return (
    (error as { code?: string })?.code === UNIQUE_VIOLATION ||
    cause?.code === UNIQUE_VIOLATION
  );
}

// Upsert: the first write creates the row with the defaults for the rest.
export async function writeCardMeta(input: {
  taskId: string;
  workspaceId: string;
  patch: CardMetaPatch;
  actorId: string;
}) {
  const { costUsd, ...rest } = input.patch;
  const values = {
    ...rest,
    ...(costUsd === undefined
      ? {}
      : { costUsd: costUsd === null ? null : costUsd.toFixed(4) }),
    updatedBy: input.actorId,
    updatedAt: new Date(),
  };
  try {
    const [row] = await db
      .insert(cardMetaTable)
      .values({
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        ...values,
      })
      .onConflictDoUpdate({ target: cardMetaTable.taskId, set: values })
      .returning();
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HTTPException(409, {
        message: "backlogId is already used by another card in this workspace",
      });
    }
    throw error;
  }
}
