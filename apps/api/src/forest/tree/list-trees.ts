import { and, desc, eq, gt, inArray, notExists, sql } from "drizzle-orm";
import db from "../../database";
import {
  sectorTable,
  sectorTreeTable,
  taskLeaseTable,
} from "../../database/forest-schema";
import {
  projectTable,
  taskRelationTable,
  taskTable,
} from "../../database/schema";
import { projectAccessCondition } from "../../project-access/project-access-condition";
import { taskIsCompleted } from "../../task/task-is-completed";

export const TREES_MAX = 100;

// Branches under each root: subtask links walked down. UNION drops repeated
// pairs, so a subtask cycle ends.
async function countBranches(rootIds: string[]) {
  if (!rootIds.length) return new Map<string, number>();
  const result = await db.execute<{ root_id: string; branches: string }>(sql`
    WITH RECURSIVE tree(root_id, task_id) AS (
      SELECT id, id FROM task WHERE id IN (${sql.join(
        rootIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      UNION
      SELECT tree.root_id, r.target_task_id
      FROM task_relation r
      JOIN tree ON r.source_task_id = tree.task_id
      WHERE r.relation_type = 'subtask'
    )
    SELECT root_id, COUNT(*) - 1 AS branches FROM tree GROUP BY root_id
  `);
  return new Map(result.rows.map((row) => [row.root_id, Number(row.branches)]));
}

// Trees of the workspace (R-028): tasks no subtask link points to, newest
// first, only in projects the caller can see.
export async function listTrees(
  workspaceId: string,
  userId: string,
  projectId?: string,
) {
  const now = new Date();
  const rows = await db
    .select({
      id: taskTable.id,
      number: taskTable.number,
      title: taskTable.title,
      status: taskTable.status,
      isCompleted: taskIsCompleted,
      priority: taskTable.priority,
      projectId: taskTable.projectId,
      projectName: projectTable.name,
      projectSlug: projectTable.slug,
      createdAt: taskTable.createdAt,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(
      and(
        eq(projectTable.workspaceId, workspaceId),
        projectId ? eq(projectTable.id, projectId) : undefined,
        projectAccessCondition(userId, projectTable.id),
        notExists(
          db
            .select({ id: taskRelationTable.id })
            .from(taskRelationTable)
            .where(
              and(
                eq(taskRelationTable.targetTaskId, taskTable.id),
                eq(taskRelationTable.relationType, "subtask"),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(taskTable.createdAt), desc(taskTable.id))
    .limit(TREES_MAX + 1);
  const trees = rows.slice(0, TREES_MAX);
  const ids = trees.map((tree) => tree.id);
  const [branches, leases, sectors] = await Promise.all([
    countBranches(ids),
    ids.length
      ? db
          .select({
            taskId: taskLeaseTable.taskId,
            holderName: taskLeaseTable.holderName,
            holderKind: taskLeaseTable.holderKind,
            expiresAt: taskLeaseTable.expiresAt,
          })
          .from(taskLeaseTable)
          .where(
            and(
              inArray(taskLeaseTable.taskId, ids),
              gt(taskLeaseTable.expiresAt, now),
            ),
          )
      : [],
    ids.length
      ? db
          .select({
            taskId: sectorTreeTable.taskId,
            sectorId: sectorTreeTable.sectorId,
          })
          .from(sectorTreeTable)
          .innerJoin(sectorTable, eq(sectorTreeTable.sectorId, sectorTable.id))
          .where(
            and(
              inArray(sectorTreeTable.taskId, ids),
              eq(sectorTable.status, "active"),
            ),
          )
      : [],
  ]);
  return {
    trees: trees.map(({ createdAt: _, ...tree }) => {
      const lease = leases.find((row) => row.taskId === tree.id);
      return {
        ...tree,
        branchCount: branches.get(tree.id) ?? 0,
        lease: lease
          ? {
              holderName: lease.holderName,
              holderKind: lease.holderKind,
              expiresAt: lease.expiresAt,
            }
          : null,
        sectorIds: sectors
          .filter((row) => row.taskId === tree.id)
          .map((row) => row.sectorId),
      };
    }),
    truncated: rows.length > TREES_MAX,
  };
}
