import { inArray, sql } from "drizzle-orm";
import db from "../../database";
import { cardMetaTable } from "../../database/forest-schema";
import {
  capDistinct,
  DECISION_PATTERN,
  DECISIONS_PER_CARD,
  decisionRef,
  FILES_PER_CARD,
  filePath,
} from "./graph-refs";

function byCard(rows: { cardId: string; value: string }[], cap: number) {
  const values = new Map<string, string[]>();
  for (const row of rows) {
    values.set(row.cardId, [...(values.get(row.cardId) ?? []), row.value]);
  }
  return new Map(
    [...values].map(([cardId, list]) => [cardId, capDistinct(list, cap)]),
  );
}

// Files a card touched (R-024), one node per file whatever the line.
export async function cardFiles(cardIds: string[]) {
  if (!cardIds.length) return new Map<string, string[]>();
  const rows = await db
    .select({ cardId: cardMetaTable.taskId, files: cardMetaTable.files })
    .from(cardMetaTable)
    .where(inArray(cardMetaTable.taskId, cardIds));
  return byCard(
    rows.flatMap((row) =>
      row.files.map((file) => ({ cardId: row.cardId, value: filePath(file) })),
    ),
    FILES_PER_CARD,
  );
}

// Decisions a card cites. Only the matches leave the database, not the text.
export async function cardDecisions(cardIds: string[]) {
  if (!cardIds.length) return new Map<string, string[]>();
  const result = await db.execute<{ card_id: string; ref: string }>(sql`
    SELECT DISTINCT t.id AS card_id, m[1] AS ref
    FROM task t
    LEFT JOIN card_meta cm ON cm.task_id = t.id
    CROSS JOIN LATERAL regexp_matches(
      concat_ws(' ', t.title, t.description, cm.report), ${DECISION_PATTERN}, 'g'
    ) AS m
    WHERE t.id IN (${sql.join(
      cardIds.map((id) => sql`${id}`),
      sql`, `,
    )})
  `);
  return byCard(
    result.rows.map((row) => ({
      cardId: row.card_id,
      value: decisionRef(row.ref),
    })),
    DECISIONS_PER_CARD,
  );
}
