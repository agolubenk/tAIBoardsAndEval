export type CardHolder = { name: string; kind: string; until: Date };
export type CardSession = {
  name: string;
  kind: string;
  step: string;
  at: Date;
};

export type CardWorker = {
  taskId: string;
  holder: CardHolder | null;
  session: CardSession | null;
  executor: string | null;
};

// One entry per card that has anyone on it. Sessions come newest first, so the
// first session naming a card is the one the board shows.
export function mergeCardWorkers(
  holders: (CardHolder & { taskId: string })[],
  sessions: (CardSession & { taskId: string | null })[],
  executors: { taskId: string; executor: string | null }[],
): CardWorker[] {
  const byTask = new Map<string, CardWorker>();
  const entry = (taskId: string) => {
    let worker = byTask.get(taskId);
    if (!worker) {
      worker = { taskId, holder: null, session: null, executor: null };
      byTask.set(taskId, worker);
    }
    return worker;
  };
  for (const { taskId, ...holder } of holders) entry(taskId).holder = holder;
  for (const { taskId, ...session } of sessions) {
    if (!taskId) continue;
    const worker = entry(taskId);
    worker.session ??= session;
  }
  for (const { taskId, executor } of executors) {
    if (executor) entry(taskId).executor = executor;
  }
  return [...byTask.values()];
}
