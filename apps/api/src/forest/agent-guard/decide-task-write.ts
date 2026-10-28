import type { TaskApprovalAction } from "../approval/approval-params";
import type { TaskChanges } from "./classify-task-request";

export type CurrentTask = {
  title: string;
  description: string | null;
  status: string;
  priority: string;
};

export type WriteFacts = {
  // The status the card would land in closes it (final column, archived).
  closes: boolean;
  // An agent created this card, so its text is not the owner's statement.
  authoredByAgent: boolean;
};

export type WriteDecision =
  | { kind: "deny"; reason: string }
  | {
      kind: "allow";
      approval: { action: TaskApprovalAction; value: string } | null;
    };

// R-022 and N-004 for one agent edit: the owner's text stays the owner's,
// closing and reprioritising wait for the owner's «да», the rest goes.
export function changesText(changes: TaskChanges, current: CurrentTask) {
  return (
    (changes.title !== undefined && changes.title !== current.title) ||
    (changes.description !== undefined &&
      (changes.description ?? "") !== (current.description ?? ""))
  );
}

export function decideTaskWrite(
  changes: TaskChanges,
  current: CurrentTask,
  facts: WriteFacts,
): WriteDecision {
  if (changesText(changes, current) && !facts.authoredByAgent) {
    return {
      kind: "deny",
      reason:
        "the card text is the owner's statement (N-004); add a comment instead",
    };
  }

  const closing =
    changes.status !== undefined &&
    changes.status !== current.status &&
    facts.closes;
  const priorityChanged =
    changes.priority !== undefined && changes.priority !== current.priority;
  if (closing && priorityChanged) {
    return {
      kind: "deny",
      reason:
        "closing and a priority change need separate approvals; send them one at a time",
    };
  }
  if (closing && changes.status) {
    return {
      kind: "allow",
      approval: { action: "close_task", value: changes.status },
    };
  }
  if (priorityChanged && changes.priority) {
    return {
      kind: "allow",
      approval: { action: "set_priority", value: changes.priority },
    };
  }
  return { kind: "allow", approval: null };
}
