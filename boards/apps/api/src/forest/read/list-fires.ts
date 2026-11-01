import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import db from "../../database";
import { cardMetaTable } from "../../database/forest-schema";
import { columnTable, projectTable, taskTable } from "../../database/schema";
import { projectAccessCondition } from "../../project-access/project-access-condition";
import { pageSize } from "./page-cursor";

// Severity is free text from Notion and agents («High», «major», «Критичная»),
// so a hot bug is recognised by the start of the word. Cyrillic capitals are
// spelled out: a database with the C locale folds case for ASCII only.
const HOT_SEVERITY = "^(crit|block|high|major|p0|p1|[кК]рит|[бБ]лок|[вВ]ысок)";

// What is on fire (R-090): open bugs and urgent cards the reader may open,
// hot bugs first, then urgent cards, then other bugs; oldest first inside each
// group, since those have burned longest. `total` counts all of them.
export async function listFires({
  workspaceId,
  userId,
  take,
}: {
  workspaceId: string;
  userId: string;
  take?: number;
}) {
  const rank = sql<number>`case
    when ${cardMetaTable.kind} = 'bug' and coalesce(${cardMetaTable.severity}, '') ~* ${HOT_SEVERITY} then 0
    when ${taskTable.priority} = 'urgent' then 1
    else 2 end`;
  const rows = await db
    .select({
      taskId: taskTable.id,
      number: taskTable.number,
      title: taskTable.title,
      status: taskTable.status,
      priority: taskTable.priority,
      kind: cardMetaTable.kind,
      severity: cardMetaTable.severity,
      projectId: projectTable.id,
      projectName: projectTable.name,
      createdAt: taskTable.createdAt,
      hot: sql<boolean>`${rank} = 0`,
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .leftJoin(cardMetaTable, eq(cardMetaTable.taskId, taskTable.id))
    .leftJoin(
      columnTable,
      and(
        eq(columnTable.projectId, taskTable.projectId),
        eq(columnTable.slug, taskTable.status),
      ),
    )
    .where(
      and(
        eq(projectTable.workspaceId, workspaceId),
        isNull(projectTable.archivedAt),
        ne(taskTable.status, "archived"),
        or(isNull(columnTable.isFinal), eq(columnTable.isFinal, false)),
        or(eq(cardMetaTable.kind, "bug"), eq(taskTable.priority, "urgent")),
        projectAccessCondition(userId, projectTable.id),
      ),
    )
    .orderBy(asc(rank), asc(taskTable.createdAt), desc(taskTable.id))
    .limit(pageSize(take, 10));

  return {
    total: rows[0]?.total ?? 0,
    items: rows.map(({ total: _total, ...item }) => item),
  };
}
