import type { ImportedTask } from "@kaneo/importers";

export type MirroredCard = {
  taskId: string;
  projectId: string;
  notionPageId: string;
  notionEditedAt: Date | null;
};

export type NotionSyncPlan = {
  // Where new pages go: the project most mirrored cards already live in.
  projectId: string | null;
  fresh: ImportedTask[];
  changed: Array<{ taskId: string; task: ImportedTask }>;
  unchanged: number;
  // Task key → task id of every page that already has a card.
  mirrored: Map<string, string>;
};

// R-080: a page already mirrored is rewritten only when Notion edited it after
// the last import; unknown pages become new cards.
export function planNotionSync(
  tasks: readonly ImportedTask[],
  cards: readonly MirroredCard[],
): NotionSyncPlan {
  const byPageId = new Map(cards.map((card) => [card.notionPageId, card]));
  const plan: NotionSyncPlan = {
    projectId: mostCommonProject(cards),
    fresh: [],
    changed: [],
    unchanged: 0,
    mirrored: new Map(),
  };

  for (const task of tasks) {
    const pageId = task.sourceRef?.pageId;
    const card = pageId ? byPageId.get(pageId) : undefined;
    if (!card) {
      plan.fresh.push(task);
      continue;
    }
    plan.mirrored.set(task.key, card.taskId);
    if (isNewer(task.sourceRef?.lastEditedTime, card.notionEditedAt)) {
      plan.changed.push({ taskId: card.taskId, task });
    } else {
      plan.unchanged += 1;
    }
  }
  return plan;
}

function isNewer(editedTime: string | undefined, stored: Date | null) {
  if (stored === null) return true;
  const edited = Date.parse(editedTime ?? "");
  return Number.isNaN(edited) || edited > stored.getTime();
}

function mostCommonProject(cards: readonly MirroredCard[]): string | null {
  const counts = new Map<string, number>();
  let best: string | null = null;
  for (const { projectId } of cards) {
    const count = (counts.get(projectId) ?? 0) + 1;
    counts.set(projectId, count);
    if (best === null || count > (counts.get(best) ?? 0)) best = projectId;
  }
  return best;
}

const MAX_TASK_NUMBER = 2_147_483_647;

// New pages keep their Notion number when the project has it free; the rest
// continue after the project's last number.
export function numberFreshTasks(
  sourceNumbers: readonly (number | undefined)[],
  taken: ReadonlySet<number>,
  lastTaskNumber: number,
): { numbers: number[]; lastNumber: number } {
  const limit = MAX_TASK_NUMBER - sourceNumbers.length;
  const kept = new Set<number>();
  const keeps = sourceNumbers.map((number) => {
    if (
      number === undefined ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      number > limit ||
      taken.has(number) ||
      kept.has(number)
    ) {
      return false;
    }
    kept.add(number);
    return true;
  });

  let last = lastTaskNumber;
  for (const number of kept) last = Math.max(last, number);
  const numbers = sourceNumbers.map((number, index) =>
    keeps[index] && number !== undefined ? number : ++last,
  );
  return { numbers, lastNumber: last };
}
