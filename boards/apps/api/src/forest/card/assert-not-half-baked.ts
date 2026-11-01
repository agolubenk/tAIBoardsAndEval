import type { ForestActor } from "../actor";
import { ForestError } from "../forest-error";
import { writeJournal } from "../journal";
import { loadCardMeta } from "./card-meta";

// An agent does not take a raw idea into work without the owner's go-ahead:
// the owner clears half-baked first (Q-011, rule 17 of the main repo).
export async function assertNotHalfBaked(
  actor: ForestActor,
  taskId: string,
  workspaceId: string,
) {
  if (actor.kind !== "agent") return;
  if (!(await loadCardMeta(taskId))?.halfBaked) return;
  const error = new ForestError(
    "half_baked",
    "the card is a half-baked idea; the owner clears it before an agent takes it",
  );
  await writeJournal({
    workspaceId,
    actor,
    action: "lease.acquire",
    targetType: "task",
    targetId: taskId,
    outcome: "denied",
    detail: error.message,
  });
  throw error;
}
