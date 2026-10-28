import { and, eq, inArray, sql } from "drizzle-orm";
import type db from "../../database";
import { projectTable, taskTable } from "../../database/schema";
import { chunk } from "../writer/chunk";
import { createPositionAllocator } from "./position-allocator";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CurrentPlacement = {
  projectId: string;
  columnId: string | null;
  status: string;
};

export async function loadPositionAllocator(
  tx: Transaction,
  projectId: string,
) {
  const maxima = await tx
    .select({
      columnId: taskTable.columnId,
      status: taskTable.status,
      max: sql<number | null>`max(${taskTable.position})`,
    })
    .from(taskTable)
    .where(eq(taskTable.projectId, projectId))
    .groupBy(taskTable.columnId, taskTable.status);
  return createPositionAllocator(maxima);
}

export async function loadPlacements(
  tx: Transaction,
  taskIds: readonly string[],
): Promise<Map<string, CurrentPlacement>> {
  const placements = new Map<string, CurrentPlacement>();
  for (const batch of chunk(taskIds)) {
    const rows = await tx
      .select({
        id: taskTable.id,
        projectId: taskTable.projectId,
        columnId: taskTable.columnId,
        status: taskTable.status,
      })
      .from(taskTable)
      .where(inArray(taskTable.id, batch));
    for (const { id, ...placement } of rows) placements.set(id, placement);
  }
  return placements;
}

// Locks the project row so a concurrent task create cannot take the numbers.
export async function loadNumbering(
  tx: Transaction,
  projectId: string,
  sourceNumbers: readonly (number | undefined)[],
): Promise<{ taken: Set<number>; lastTaskNumber: number }> {
  const [project] = await tx
    .select({ lastTaskNumber: projectTable.lastTaskNumber })
    .from(projectTable)
    .where(eq(projectTable.id, projectId))
    .for("update");
  const wanted = [
    ...new Set(
      sourceNumbers.filter(
        (number): number is number =>
          number !== undefined && Number.isSafeInteger(number),
      ),
    ),
  ];
  const taken = new Set<number>();
  for (const batch of chunk(wanted)) {
    const rows = await tx
      .select({ number: taskTable.number })
      .from(taskTable)
      .where(
        and(
          eq(taskTable.projectId, projectId),
          inArray(taskTable.number, batch),
        ),
      );
    for (const { number } of rows) if (number !== null) taken.add(number);
  }
  return { taken, lastTaskNumber: project?.lastTaskNumber ?? 0 };
}
