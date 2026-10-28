import { and, eq, isNotNull } from "drizzle-orm";
import db from "../../database";
import { cardMetaTable } from "../../database/forest-schema";
import {
  columnTable,
  taskTable,
  workspaceUserTable,
} from "../../database/schema";
import type { MirrorCardRow } from "./mirror-snapshot";

// Every mirrored card of the project, including ones whose page Notion no
// longer returns: those are what `missing-in-source` reports.
export async function loadMirrorRows(
  projectId: string,
): Promise<MirrorCardRow[]> {
  const rows = await db
    .select({
      taskId: taskTable.id,
      title: taskTable.title,
      status: taskTable.status,
      columnSlug: columnTable.slug,
      notionPageId: cardMetaTable.notionPageId,
    })
    .from(taskTable)
    .innerJoin(cardMetaTable, eq(cardMetaTable.taskId, taskTable.id))
    .leftJoin(columnTable, eq(columnTable.id, taskTable.columnId))
    .where(
      and(
        eq(taskTable.projectId, projectId),
        isNotNull(cardMetaTable.notionPageId),
      ),
    );
  return rows.flatMap(({ notionPageId, ...row }) =>
    notionPageId ? [{ ...row, notionPageId }] : [],
  );
}

// The scheduled mirror writes as the workspace's owner: new cards need an
// author, and the owner is who the mirror answers to.
export async function findWorkspaceOwner(
  workspaceId: string,
): Promise<string | null> {
  const [owner] = await db
    .select({ userId: workspaceUserTable.userId })
    .from(workspaceUserTable)
    .where(
      and(
        eq(workspaceUserTable.workspaceId, workspaceId),
        eq(workspaceUserTable.role, "owner"),
      ),
    )
    .limit(1);
  return owner?.userId ?? null;
}
