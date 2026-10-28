import type { ImportedTask } from "@kaneo/importers";
import { type NotionCardMeta, notionCardMeta } from "./notion-card-meta";

export function notionMetaRows(
  tasks: readonly ImportedTask[],
  taskIds: ReadonlyMap<string, string>,
): Array<{ taskId: string; meta: NotionCardMeta }> {
  return tasks.flatMap((task) => {
    const taskId = taskIds.get(task.key);
    const meta = notionCardMeta(task);
    return taskId && meta ? [{ taskId, meta }] : [];
  });
}
