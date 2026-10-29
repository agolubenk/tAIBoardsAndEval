import { asc, eq } from "drizzle-orm";
import db from "../database";
import { columnTable } from "../database/schema";
import {
  PROJECT_PROCESSES,
  type ProjectProcess,
} from "../project/project-processes";

// A board made before the process has Kaneo's four columns. The seed adds the
// missing ones and puts the process in order; a column people added keeps its
// place after the process, and nothing is renamed or removed. A board that
// already has every column is left as it is, order included.
export async function ensureProcessColumns(
  projectId: string,
  process: ProjectProcess = "tasks",
): Promise<number> {
  const processColumns = PROJECT_PROCESSES[process];
  return db.transaction(async (tx) => {
    const columns = await tx
      .select({ id: columnTable.id, slug: columnTable.slug })
      .from(columnTable)
      .where(eq(columnTable.projectId, projectId))
      .orderBy(asc(columnTable.position));
    const present = new Set(columns.map((column) => column.slug));
    const missing = processColumns.filter(
      (column) => !present.has(column.slug),
    );
    if (!missing.length) return 0;

    await tx.insert(columnTable).values(
      missing.map((column) => ({
        projectId,
        name: column.name,
        slug: column.slug,
        position: column.position,
        isFinal: column.isFinal,
      })),
    );
    const positions = new Map<string, number>(
      processColumns.map((column) => [column.slug, column.position]),
    );
    const others = columns.filter((column) => !positions.has(column.slug));
    for (const column of columns) {
      const position =
        positions.get(column.slug) ??
        processColumns.length + others.indexOf(column);
      await tx
        .update(columnTable)
        .set({ position })
        .where(eq(columnTable.id, column.id));
    }
    return missing.length;
  });
}
