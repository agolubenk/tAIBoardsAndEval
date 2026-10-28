import { and, isNotNull, sql } from "drizzle-orm";
import db from "../../database";
import { notebookMessageTable } from "../../database/notebook-schema";

// The daily cap guards one shared model key, so it counts calls from every
// workspace on purpose. A call holds its place from the check until its answer
// row is stored, and checks and releases run one at a time: a burst of
// questions cannot all pass the check before the first answer lands, and a
// count read while an answer is being stored still sees that call. The
// notebook runs on one API instance, so the places live in memory.
let reserved = 0;
let gate: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(step: () => Promise<T> | T): Promise<T> {
  const run = gate.then(step);
  gate = run.catch(() => {});
  return run;
}

export async function cloudCallsToday(): Promise<number> {
  return db.$count(
    notebookMessageTable,
    and(
      isNotNull(notebookMessageTable.model),
      sql`${notebookMessageTable.createdAt} >= date_trunc('day', now() AT TIME ZONE 'utc')`,
    ),
  );
}

export function reserveCall(dailyMax: number): Promise<boolean> {
  return oneAtATime(async () => {
    if ((await cloudCallsToday()) + reserved >= dailyMax) return false;
    reserved += 1;
    return true;
  });
}

// Call once the answer row is stored (or failed to store).
export function releaseCall(): Promise<void> {
  return oneAtATime(() => {
    reserved = Math.max(0, reserved - 1);
  });
}
