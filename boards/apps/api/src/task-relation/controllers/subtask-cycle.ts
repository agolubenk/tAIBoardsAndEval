import { sql } from "drizzle-orm";
import type db from "../../database";

type Executor = Pick<typeof db, "execute">;

// Ancestors are walked through every parent link (not only the oldest one the
// tree view uses), so a cycle through any parent is caught. The cap keeps the
// walk bounded even when old data already holds a cycle.
const ANCESTOR_DEPTH_MAX = 64;

// A subtask link parent → child closes a loop when the child is already the
// parent itself or one of its ancestors: the forest (trees, sectors, felling)
// relies on subtask links forming trees. Idea from OpenProject's relation
// checks on save (GPLv3, idea only — docs/integrations/openproject/README.md).
export async function wouldCloseSubtaskCycle(
  executor: Executor,
  parentId: string,
  childId: string,
) {
  const result = await executor.execute<{ hit: boolean }>(sql`
    WITH RECURSIVE up(task_id, depth) AS (
      SELECT ${parentId}::text, 0
      UNION
      SELECT r.source_task_id, up.depth + 1
      FROM up
      JOIN task_relation r
        ON r.target_task_id = up.task_id AND r.relation_type = 'subtask'
      WHERE up.depth < ${ANCESTOR_DEPTH_MAX}
    )
    SELECT EXISTS (SELECT 1 FROM up WHERE task_id = ${childId}) AS hit
  `);
  return Boolean(result.rows[0]?.hit);
}
