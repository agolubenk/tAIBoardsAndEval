import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { sectorTable, sectorTreeTable } from "../../database/forest-schema";
import { ForestError } from "../forest-error";
import { assertTaskInWorkspace } from "../task-scope";
import type { FellAction } from "./approval-params";

// The trees an approval covers come from the server, never from the
// requester: the owner approves exactly what a felling would take.
export async function fellTargets(
  workspaceId: string,
  userId: string,
  action: FellAction,
  targetId: string,
): Promise<{ targetType: "task" | "sector"; treeIds: string[] }> {
  if (action === "fell_tree") {
    await assertTaskInWorkspace(targetId, workspaceId, userId);
    return { targetType: "task", treeIds: [targetId] };
  }
  const [sector] = await db
    .select({ status: sectorTable.status })
    .from(sectorTable)
    .where(
      and(
        eq(sectorTable.id, targetId),
        eq(sectorTable.workspaceId, workspaceId),
      ),
    );
  if (!sector) throw new HTTPException(404, { message: "Sector not found" });
  if (sector.status !== "active") {
    throw new ForestError("felled", "sector is not active");
  }
  const rows = await db
    .select({ taskId: sectorTreeTable.taskId })
    .from(sectorTreeTable)
    .where(eq(sectorTreeTable.sectorId, targetId));
  return { targetType: "sector", treeIds: rows.map((row) => row.taskId) };
}
