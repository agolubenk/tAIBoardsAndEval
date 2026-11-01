import { and, eq, gt, inArray, ne, or, type SQL, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Tx } from "../tx";
import { taskLeaseTable } from "../../database/forest-schema";
import {
  activityTable,
  assetTable,
  labelTable,
  projectTable,
  taskRelationTable,
  taskTable,
} from "../../database/schema";
import { ForestError } from "../forest-error";
import type { OuterLink, TreeMaterial } from "./tree-material";

export const FELLING_TASK_LIMIT = 500;

function inList(ids: readonly string[]): SQL {
  return sql`(${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}

async function descendantsByRoot(tx: Tx, rootIds: string[]) {
  // UNION (not UNION ALL) drops repeated pairs, so a subtask cycle ends.
  const result = await tx.execute<{ root_id: string; task_id: string }>(sql`
    WITH RECURSIVE tree(root_id, task_id) AS (
      SELECT id, id FROM task WHERE id IN ${inList(rootIds)}
      UNION
      SELECT tree.root_id, r.target_task_id
      FROM task_relation r
      JOIN tree ON r.source_task_id = tree.task_id
      WHERE r.relation_type = 'subtask'
    )
    SELECT root_id, task_id FROM tree LIMIT ${FELLING_TASK_LIMIT + 1}
  `);
  return result.rows;
}

async function assertRootsAreTrees(tx: Tx, rootIds: string[]) {
  const [parented] = await tx
    .select({ childId: taskRelationTable.targetTaskId })
    .from(taskRelationTable)
    .where(
      and(
        inArray(taskRelationTable.targetTaskId, rootIds),
        eq(taskRelationTable.relationType, "subtask"),
      ),
    )
    .limit(1);
  if (parented) {
    throw new ForestError(
      "not_a_tree",
      `task ${parented.childId} is a branch; fell its root or compress it into seeds`,
    );
  }
}

async function assertNoLiveLease(tx: Tx, taskIds: string[]) {
  const live = await tx
    .select({
      taskId: taskLeaseTable.taskId,
      holderName: taskLeaseTable.holderName,
    })
    .from(taskLeaseTable)
    .where(
      and(
        inArray(taskLeaseTable.taskId, taskIds),
        gt(taskLeaseTable.expiresAt, new Date()),
      ),
    )
    .limit(10);
  if (live.length > 0) {
    const holders = [...new Set(live.map((lease) => lease.holderName))];
    throw new ForestError(
      "lease_conflict",
      `work in progress, held by ${holders.join(", ")}`,
    );
  }
}

async function outerLinks(tx: Tx, taskIds: string[]): Promise<OuterLink[]> {
  const felled = new Set(taskIds);
  const rows = await tx
    .select({
      sourceTaskId: taskRelationTable.sourceTaskId,
      targetTaskId: taskRelationTable.targetTaskId,
      relationType: taskRelationTable.relationType,
    })
    .from(taskRelationTable)
    .where(
      and(
        ne(taskRelationTable.relationType, "subtask"),
        or(
          inArray(taskRelationTable.sourceTaskId, taskIds),
          inArray(taskRelationTable.targetTaskId, taskIds),
        ),
      ),
    );
  const crossing = rows.filter(
    (row) => !(felled.has(row.sourceTaskId) && felled.has(row.targetTaskId)),
  );
  const otherIds = crossing.map((row) =>
    felled.has(row.sourceTaskId) ? row.targetTaskId : row.sourceTaskId,
  );
  const titles = otherIds.length
    ? await tx
        .select({ id: taskTable.id, title: taskTable.title })
        .from(taskTable)
        .where(inArray(taskTable.id, [...new Set(otherIds)]))
    : [];
  const titleOf = new Map(titles.map((row) => [row.id, row.title]));
  return crossing.map((row) => {
    const out = felled.has(row.sourceTaskId);
    const otherTaskId = out ? row.targetTaskId : row.sourceTaskId;
    return {
      felledTaskId: out ? row.sourceTaskId : row.targetTaskId,
      otherTaskId,
      otherTitle: titleOf.get(otherTaskId) ?? otherTaskId,
      relationType: row.relationType,
      direction: out ? "out" : "in",
    };
  });
}

// Reads and locks whole trees for a felling, inside its transaction. Roots
// are locked first so nothing is re-parented under them while we read.
export async function collectTreeMaterial(
  tx: Tx,
  workspaceId: string,
  rootIds: string[],
) {
  const roots = await tx
    .select({ id: taskTable.id, workspaceId: projectTable.workspaceId })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(inArray(taskTable.id, rootIds))
    .for("update", { of: taskTable });
  if (roots.length !== rootIds.length) {
    throw new HTTPException(404, { message: "Tree not found" });
  }
  if (roots.some((root) => root.workspaceId !== workspaceId)) {
    throw new ForestError(
      "cross_product",
      "every tree must belong to this workspace",
    );
  }
  await assertRootsAreTrees(tx, rootIds);

  const pairs = await descendantsByRoot(tx, rootIds);
  if (pairs.length > FELLING_TASK_LIMIT) {
    throw new ForestError(
      "too_large",
      `a felling takes at most ${FELLING_TASK_LIMIT} tasks`,
    );
  }
  // A task reachable from two roots is felled once, with the first root.
  const rootOf = new Map<string, string>();
  for (const pair of pairs) {
    if (!rootOf.has(pair.task_id)) rootOf.set(pair.task_id, pair.root_id);
  }
  const taskIds = [...rootOf.keys()];

  const tasks = await tx
    .select({
      task: taskTable,
      projectName: projectTable.name,
      workspaceId: projectTable.workspaceId,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(inArray(taskTable.id, taskIds))
    .for("update", { of: taskTable });
  if (tasks.some((row) => row.workspaceId !== workspaceId)) {
    throw new ForestError(
      "cross_product",
      "a branch lives in another workspace",
    );
  }
  await assertNoLiveLease(tx, taskIds);

  const [activities, labels, assets, edges, links] = await Promise.all([
    tx
      .select({
        taskId: activityTable.taskId,
        type: activityTable.type,
        content: activityTable.content,
        userId: activityTable.userId,
        createdAt: activityTable.createdAt,
        eventData: activityTable.eventData,
      })
      .from(activityTable)
      .where(inArray(activityTable.taskId, taskIds)),
    tx
      .select({ taskId: labelTable.taskId, name: labelTable.name })
      .from(labelTable)
      .where(inArray(labelTable.taskId, taskIds)),
    tx
      .select({
        taskId: assetTable.taskId,
        name: assetTable.filename,
        objectKey: assetTable.objectKey,
      })
      .from(assetTable)
      .where(inArray(assetTable.taskId, taskIds)),
    tx
      .select({
        parentId: taskRelationTable.sourceTaskId,
        childId: taskRelationTable.targetTaskId,
      })
      .from(taskRelationTable)
      .where(
        and(
          eq(taskRelationTable.relationType, "subtask"),
          inArray(taskRelationTable.sourceTaskId, taskIds),
        ),
      ),
    outerLinks(tx, taskIds),
  ]);

  const materials: TreeMaterial[] = rootIds.map((rootId) => {
    const inTree = (taskId: string | null) =>
      taskId !== null && rootOf.get(taskId) === rootId;
    const treeTasks = tasks.filter((row) => inTree(row.task.id));
    const rootRow = treeTasks.find((row) => row.task.id === rootId);
    if (!rootRow) throw new HTTPException(404, { message: "Tree not found" });
    return {
      root: rootRow.task,
      projectName: rootRow.projectName,
      tasks: treeTasks.map((row) => row.task),
      edges: edges.filter(
        (edge) => inTree(edge.parentId) && inTree(edge.childId),
      ),
      activities: activities.filter((a) => inTree(a.taskId)),
      labels: labels
        .filter((label) => inTree(label.taskId))
        .map((label) => ({ taskId: label.taskId as string, name: label.name })),
      assets: assets
        .filter((asset) => inTree(asset.taskId))
        .map((asset) => ({ taskId: asset.taskId as string, name: asset.name })),
      outerLinks: links.filter((link) => inTree(link.felledTaskId)),
    };
  });

  return {
    materials,
    taskIds,
    assetObjectKeys: assets.map((asset) => asset.objectKey),
  };
}
