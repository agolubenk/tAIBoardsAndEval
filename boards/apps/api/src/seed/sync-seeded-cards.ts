import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import db, { schema } from "../database";
import { cardHistoryTable, cardMetaTable } from "../database/forest-schema";
import { setHistoryActor } from "../forest/history/history-fields";
import { nextTaskPosition } from "../task/controllers/next-task-position";
import type { PlannedCard } from "./products-plan-schema";

// A card the seed wrote that nobody has edited since still holds the plan's
// words, so it follows the current plan: title, text, status, priority. The
// first edit by a person or agent leaves a history row with another actor
// (people's rows have none), and from then on the board owns the card.
// The owner runs the seed (install.sh), so a status it moves is the owner's.
export async function syncSeededCards(
  workspaceId: string,
  cards: PlannedCard[],
  seedActor: string,
): Promise<number> {
  if (!cards.length) return 0;
  const live = await db
    .select({
      key: cardMetaTable.backlogId,
      id: schema.taskTable.id,
      projectId: schema.taskTable.projectId,
      title: schema.taskTable.title,
      description: schema.taskTable.description,
      status: schema.taskTable.status,
      priority: schema.taskTable.priority,
    })
    .from(cardMetaTable)
    .innerJoin(schema.taskTable, eq(schema.taskTable.id, cardMetaTable.taskId))
    .where(
      and(
        eq(cardMetaTable.workspaceId, workspaceId),
        inArray(
          cardMetaTable.backlogId,
          cards.map((card) => card.key),
        ),
      ),
    );
  if (!live.length) return 0;

  const edited = await db
    .selectDistinct({ taskId: cardHistoryTable.taskId })
    .from(cardHistoryTable)
    .where(
      and(
        inArray(
          cardHistoryTable.taskId,
          live.map((task) => task.id),
        ),
        eq(cardHistoryTable.kind, "task"),
        or(
          isNull(cardHistoryTable.actorId),
          ne(cardHistoryTable.actorId, seedActor),
        ),
      ),
    );
  const touched = new Set(edited.map((row) => row.taskId));
  const planned = new Map(cards.map((card) => [card.key, card]));

  let synced = 0;
  for (const task of live) {
    const card = task.key ? planned.get(task.key) : undefined;
    if (!card || touched.has(task.id)) continue;
    if (
      task.title === card.title &&
      (task.description ?? "") === card.description &&
      task.status === card.status &&
      task.priority === card.priority
    )
      continue;
    await db.transaction(async (tx) => {
      await setHistoryActor(tx, seedActor);
      const moved = task.status !== card.status;
      const [column] = moved
        ? await tx
            .select({ id: schema.columnTable.id })
            .from(schema.columnTable)
            .where(
              and(
                eq(schema.columnTable.projectId, task.projectId),
                eq(schema.columnTable.slug, card.status),
              ),
            )
        : [];
      await tx
        .update(schema.taskTable)
        .set({
          title: card.title,
          description: card.description,
          priority: card.priority,
          ...(moved && {
            status: card.status,
            columnId: column?.id ?? null,
            position: await nextTaskPosition(
              tx,
              task.projectId,
              card.status,
              column?.id ?? null,
            ),
          }),
        })
        .where(eq(schema.taskTable.id, task.id));
    });
    synced++;
  }
  return synced;
}
