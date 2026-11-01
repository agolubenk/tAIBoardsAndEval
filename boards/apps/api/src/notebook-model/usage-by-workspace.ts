import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import db, { schema } from "../database";
import { notebookMessageTable } from "../database/notebook-schema";

// Today's model calls per product, so the admin sees who spends the shared
// daily limit. Only answers that called the model carry a model.
export async function usageByWorkspace() {
  const calls = sql<number>`count(*)::int`;
  return db
    .select({
      workspaceId: notebookMessageTable.workspaceId,
      name: schema.workspaceTable.name,
      calls,
    })
    .from(notebookMessageTable)
    .innerJoin(
      schema.workspaceTable,
      eq(schema.workspaceTable.id, notebookMessageTable.workspaceId),
    )
    .where(
      and(
        isNotNull(notebookMessageTable.model),
        sql`${notebookMessageTable.createdAt} >= date_trunc('day', now() AT TIME ZONE 'utc')`,
      ),
    )
    .groupBy(notebookMessageTable.workspaceId, schema.workspaceTable.name)
    .orderBy(desc(calls))
    .limit(100);
}
