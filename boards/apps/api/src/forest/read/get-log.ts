import { and, asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { seedTable, timberLogTable } from "../../database/forest-schema";

export async function getLog(workspaceId: string, logId: string) {
  const [log] = await db
    .select()
    .from(timberLogTable)
    .where(
      and(
        eq(timberLogTable.id, logId),
        eq(timberLogTable.workspaceId, workspaceId),
      ),
    );
  if (!log) throw new HTTPException(404, { message: "Log not found" });
  const seeds = await db
    .select({
      id: seedTable.id,
      kind: seedTable.kind,
      title: seedTable.title,
      body: seedTable.body,
      sourceTaskIds: seedTable.sourceTaskIds,
      contentHash: seedTable.contentHash,
      compressor: seedTable.compressor,
      revision: seedTable.revision,
      createdAt: seedTable.createdAt,
    })
    .from(seedTable)
    .where(eq(seedTable.logId, logId))
    .orderBy(asc(seedTable.createdAt), asc(seedTable.id))
    .limit(100);
  const { searchText: _searchText, ...rest } = log;
  return { ...rest, seeds };
}
