import type { ImportedColumn } from "@kaneo/importers";
import { createId } from "@paralleldrive/cuid2";
import { asc, eq } from "drizzle-orm";
import type db from "../../database";
import { columnTable } from "../../database/schema";
import { planImportColumns } from "../writer/plan-import-columns";
import type { BoardColumn } from "../writer/plan-import-tasks";
import type { ImportBoard } from "../writer/write-import-columns";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// A re-import keeps the board people may have rearranged: Notion statuses map
// to existing columns by slug, and only new statuses add columns at the end.
export async function ensureSyncColumns(
  tx: Transaction,
  projectId: string,
  columns: readonly ImportedColumn[],
): Promise<ImportBoard> {
  const existing = await tx
    .select({
      id: columnTable.id,
      slug: columnTable.slug,
      position: columnTable.position,
    })
    .from(columnTable)
    .where(eq(columnTable.projectId, projectId))
    .orderBy(asc(columnTable.position));
  const bySlug = new Map<string, BoardColumn>(
    existing.map(({ id, slug }) => [slug, { id, slug }]),
  );

  let position = (existing.at(-1)?.position ?? -1) + 1;
  const created: Array<typeof columnTable.$inferInsert & { id: string }> = [];
  const byKey = new Map<string, BoardColumn>();
  for (const column of planImportColumns(columns).columns) {
    let found = bySlug.get(column.slug);
    if (!found) {
      const row = {
        id: createId(),
        projectId,
        name: column.name,
        slug: column.slug,
        position: position++,
        isFinal: column.isFinal,
      };
      created.push(row);
      found = { id: row.id, slug: row.slug };
      bySlug.set(row.slug, found);
    }
    byKey.set(column.key, found);
  }
  if (created.length > 0) await tx.insert(columnTable).values(created);

  const first = existing[0] ?? created[0];
  return {
    byKey,
    fallback: first ? { id: first.id, slug: first.slug } : null,
    count: created.length,
  };
}
