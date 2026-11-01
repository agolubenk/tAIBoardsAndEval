import { isDeepStrictEqual } from "node:util";

export type FieldChange = { from: unknown; to: unknown };
export type HistoryChanges = Record<string, FieldChange>;

export type RollbackDecision =
  | { ok: true; restore: Record<string, unknown> }
  | { ok: false; reason: string };

// A rollback undoes one edit: each field it changed goes back to the value
// before it. A field changed again since is a conflict, so a rollback never
// drops a later edit; undo that one first. `fixed` names fields this path
// cannot restore, with the reason.
export function decideRollback(
  changes: HistoryChanges,
  current: Record<string, unknown>,
  fixed: Record<string, string> = {},
): RollbackDecision {
  const fields = Object.keys(changes);
  const blocked = fields.find((field) => field in fixed);
  if (blocked) return { ok: false, reason: `${blocked}: ${fixed[blocked]}` };
  const changedAgain = fields.filter(
    (field) => !isDeepStrictEqual(current[field], changes[field]?.to),
  );
  if (changedAgain.length > 0) {
    return {
      ok: false,
      reason: `changed again since: ${changedAgain.join(", ")}; roll back the later edit first`,
    };
  }
  return {
    ok: true,
    restore: Object.fromEntries(
      fields.map((field) => [field, changes[field]?.from]),
    ),
  };
}
