import type { CardWorker } from "@/hooks/queries/forest/use-card-workers";

// A session's state older than this reads as history, not as work in progress.
const SESSION_LIVE_MS = 12 * 60 * 60 * 1000;

export type CardWorkerLine = {
  source: "holder" | "session" | "executor";
  name: string;
  kind: string;
  step?: string;
  at?: string;
  live: boolean;
  // The executor, shown beside a holder or session only when it is someone else.
  executor: string | null;
};

export function cardWorkerLine(
  worker: CardWorker | undefined,
  now = Date.now(),
): CardWorkerLine | null {
  if (!worker) return null;
  const { holder, session, executor } = worker;
  const other = (name: string) =>
    executor && executor !== name ? executor : null;
  if (holder) {
    return {
      source: "holder",
      name: holder.name,
      kind: holder.kind,
      at: holder.until,
      live: true,
      executor: other(holder.name),
    };
  }
  if (session) {
    return {
      source: "session",
      name: session.name,
      kind: session.kind,
      step: session.step,
      at: session.at,
      live: now - new Date(session.at).getTime() < SESSION_LIVE_MS,
      executor: other(session.name),
    };
  }
  if (executor) {
    return {
      source: "executor",
      name: executor,
      kind: "executor",
      live: false,
      executor: null,
    };
  }
  return null;
}
