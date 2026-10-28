import type { CardBinding } from "@kaneo/claude-mem-reader";
import { eq } from "drizzle-orm";
import db from "../../database";
import { cardMetaTable } from "../../database/forest-schema";
import { projectTable, taskTable } from "../../database/schema";

// What an observation may name the card by: its id, its Backlog ID, its
// board number (slug-number) and the branch an agent worked on.
export async function loadCardBinding(taskId: string): Promise<CardBinding> {
  const [row] = await db
    .select({
      number: taskTable.number,
      slug: projectTable.slug,
      backlogId: cardMetaTable.backlogId,
      branch: cardMetaTable.branch,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .leftJoin(cardMetaTable, eq(cardMetaTable.taskId, taskTable.id))
    .where(eq(taskTable.id, taskId))
    .limit(1);

  const identifiers = [row?.backlogId];
  if (row?.number != null) identifiers.push(`${row.slug}-${row.number}`);
  return {
    cardId: taskId,
    branch: row?.branch ?? null,
    identifiers: identifiers.filter((value): value is string => Boolean(value)),
  };
}
