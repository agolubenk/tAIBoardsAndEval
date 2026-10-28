import { sql } from "drizzle-orm";
import type db from "../../database";
import { z } from "../../openapi";

type Executor = Pick<typeof db, "execute">;

// The task fields a history row names (t_boards_task_fields in migration
// 0069). Dates travel as UTC ISO strings.
export const taskFields = z
  .object({
    title: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    columnId: z.string().nullable(),
    priority: z.string(),
    assigneeId: z.string().nullable(),
    startDate: z.iso.datetime().nullable(),
    dueDate: z.iso.datetime().nullable(),
  })
  .partial()
  .strict();

const fieldsRow = z.object({ fields: z.record(z.string(), z.unknown()) });

// The same SQL functions the triggers use, so current values compare with
// the recorded ones exactly.
export async function currentTaskFields(executor: Executor, taskId: string) {
  const result = await executor.execute(
    sql`select t_boards_task_fields(task) as fields from task where id = ${taskId}`,
  );
  return fieldsRow.parse(result.rows[0]).fields;
}

export async function currentMetaFields(executor: Executor, taskId: string) {
  const result = await executor.execute(
    sql`select t_boards_card_meta_fields(card_meta) as fields from card_meta where task_id = ${taskId}`,
  );
  const [row] = result.rows;
  return row ? fieldsRow.parse(row).fields : null;
}

// The trigger reads it back: the rows a t-boards write adds name its actor.
export async function setHistoryActor(executor: Executor, actorId: string) {
  await executor.execute(
    sql`select set_config('t_boards.actor', ${actorId}, true)`,
  );
}
