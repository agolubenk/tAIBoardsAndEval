import { sql } from "drizzle-orm";
import db from "../../database";

// Active sectors of each card's tree (R-029): a sector holds roots, so walk
// subtask links up to them. UNION drops repeated pairs, so a cycle ends.
// Sector names are visible to every member; which cards show is decided by
// the caller's card list.
export async function cardSectors(workspaceId: string, cardIds: string[]) {
  if (!cardIds.length) return [];
  const result = await db.execute<{
    card_id: string;
    sector_id: string;
    name: string;
  }>(sql`
    WITH RECURSIVE up(card_id, task_id) AS (
      SELECT id, id FROM task WHERE id IN (${sql.join(
        cardIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      UNION
      SELECT up.card_id, r.source_task_id
      FROM task_relation r
      JOIN up ON r.target_task_id = up.task_id
      WHERE r.relation_type = 'subtask'
    )
    SELECT DISTINCT up.card_id, s.id AS sector_id, s.name
    FROM up
    JOIN sector_tree st ON st.task_id = up.task_id
    JOIN sector s ON s.id = st.sector_id
    WHERE s.workspace_id = ${workspaceId} AND s.status = 'active'
  `);
  return result.rows;
}
