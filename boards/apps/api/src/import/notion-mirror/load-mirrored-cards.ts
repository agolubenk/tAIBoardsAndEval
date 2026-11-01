import { eq, inArray } from "drizzle-orm";
import db from "../../database";
import { cardMetaTable } from "../../database/forest-schema";
import { taskTable } from "../../database/schema";
import { chunk } from "../writer/chunk";
import type { MirroredCard } from "./plan-notion-sync";

export type LoadedMirroredCard = MirroredCard & { workspaceId: string };

// Across workspaces: notion_page_id is unique, so a page mirrored elsewhere
// cannot get a second card here.
export async function loadMirroredCards(
  pageIds: readonly string[],
): Promise<LoadedMirroredCard[]> {
  const cards: LoadedMirroredCard[] = [];
  for (const batch of chunk(pageIds)) {
    const rows = await db
      .select({
        taskId: cardMetaTable.taskId,
        workspaceId: cardMetaTable.workspaceId,
        projectId: taskTable.projectId,
        notionPageId: cardMetaTable.notionPageId,
        notionEditedAt: cardMetaTable.notionEditedAt,
      })
      .from(cardMetaTable)
      .innerJoin(taskTable, eq(taskTable.id, cardMetaTable.taskId))
      .where(inArray(cardMetaTable.notionPageId, batch));
    for (const { notionPageId, ...row } of rows) {
      if (notionPageId) cards.push({ ...row, notionPageId });
    }
  }
  return cards;
}
