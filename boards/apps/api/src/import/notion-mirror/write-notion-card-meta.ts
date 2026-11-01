import { and, eq, inArray, sql } from "drizzle-orm";
import type db from "../../database";
import { cardMetaTable } from "../../database/forest-schema";
import { chunk } from "../writer/chunk";
import {
  type NotionCardMeta,
  releaseTakenBacklogIds,
} from "./notion-card-meta";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type MetaRow = { taskId: string; meta: NotionCardMeta };

// Writes only the Notion fields: what agents recorded on the card (executor,
// branch, PRs, cost) survives a re-import.
const NOTION_FIELDS = {
  kind: sql`excluded.kind`,
  severity: sql`excluded.severity`,
  backlogId: sql`excluded.backlog_id`,
  halfBaked: sql`excluded.half_baked`,
  report: sql`excluded.report`,
  notionPageId: sql`excluded.notion_page_id`,
  notionStatus: sql`excluded.notion_status`,
  notionEditedAt: sql`excluded.notion_edited_at`,
  updatedBy: sql`excluded.updated_by`,
  updatedAt: sql`excluded.updated_at`,
};

export async function writeNotionCardMeta(
  tx: Transaction,
  input: { workspaceId: string; userId: string; rows: readonly MetaRow[] },
): Promise<string[]> {
  if (input.rows.length === 0) return [];
  const { rows, dropped } = releaseTakenBacklogIds(
    input.rows,
    await backlogIdsHeldElsewhere(tx, input.workspaceId, input.rows),
  );

  const now = new Date();
  for (const batch of chunk(rows)) {
    await tx
      .insert(cardMetaTable)
      .values(
        batch.map(({ taskId, meta }) => ({
          taskId,
          workspaceId: input.workspaceId,
          ...meta,
          updatedBy: input.userId,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({ target: cardMetaTable.taskId, set: NOTION_FIELDS });
  }

  return dropped.length > 0
    ? [
        `Left ${dropped.length === 1 ? "a card" : `${dropped.length} cards`} without a Backlog ID another card already uses: ${dropped.join(", ")}.`,
      ]
    : [];
}

async function backlogIdsHeldElsewhere(
  tx: Transaction,
  workspaceId: string,
  rows: readonly MetaRow[],
): Promise<Set<string>> {
  const ids = [
    ...new Set(
      rows.flatMap(({ meta }) => (meta.backlogId ? [meta.backlogId] : [])),
    ),
  ];
  const ours = new Set(rows.map(({ taskId }) => taskId));
  const held = new Set<string>();
  for (const batch of chunk(ids)) {
    const found = await tx
      .select({
        taskId: cardMetaTable.taskId,
        backlogId: cardMetaTable.backlogId,
      })
      .from(cardMetaTable)
      .where(
        and(
          eq(cardMetaTable.workspaceId, workspaceId),
          inArray(cardMetaTable.backlogId, batch),
        ),
      );
    for (const { taskId, backlogId } of found) {
      if (backlogId && !ours.has(taskId)) held.add(backlogId);
    }
  }
  return held;
}
