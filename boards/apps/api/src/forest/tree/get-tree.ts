import { sql } from "drizzle-orm";
import db from "../../database";
import { projectAccessCondition } from "../../project-access/project-access-condition";

export const BRANCHES_MAX = 200;
const DEPTH_MAX = 20;

type BranchRow = {
  id: string;
  parent_id: string | null;
  depth: number;
  number: number | null;
  title: string;
  status: string;
  project_id: string;
};

// A tree's branches, root first, each with its parent (R-028). Branches in
// projects the caller cannot see are left out; depth is capped so a subtask
// cycle ends.
export async function getTreeBranches(
  rootId: string,
  workspaceId: string,
  userId: string,
) {
  const result = await db.execute<BranchRow>(sql`
    WITH RECURSIVE tree(task_id, parent_id, depth) AS (
      SELECT id, NULL::text, 0 FROM task WHERE id = ${rootId}
      UNION
      SELECT r.target_task_id, r.source_task_id, tree.depth + 1
      FROM task_relation r
      JOIN tree ON r.source_task_id = tree.task_id
      WHERE r.relation_type = 'subtask' AND tree.depth < ${DEPTH_MAX}
    )
    SELECT DISTINCT ON (t.id) t.id, tree.parent_id, tree.depth, t.number,
      t.title, t.status, t.project_id
    FROM tree
    JOIN task t ON t.id = tree.task_id
    JOIN project p ON p.id = t.project_id
    WHERE p.workspace_id = ${workspaceId}
      AND ${projectAccessCondition(userId, sql`p.id`)}
    ORDER BY t.id, tree.depth
    LIMIT ${BRANCHES_MAX + 1}
  `);
  const rows = [...result.rows].sort(
    (a, b) => a.depth - b.depth || a.title.localeCompare(b.title),
  );
  return {
    rootId,
    branches: rows.slice(0, BRANCHES_MAX).map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      depth: Number(row.depth),
      number: row.number === null ? null : Number(row.number),
      title: row.title,
      status: row.status,
      projectId: row.project_id,
    })),
    truncated: rows.length > BRANCHES_MAX,
  };
}
