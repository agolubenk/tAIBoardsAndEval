import type { ImportedTask } from "@kaneo/importers";

// The Notion fields a card keeps next to kaneo's own (R-024), read from the
// page's source fields by name.
export type NotionCardMeta = {
  kind: "task" | "bug";
  severity: string | null;
  backlogId: string | null;
  halfBaked: boolean;
  report: string | null;
  notionPageId: string;
  notionStatus: string | null;
  notionEditedAt: Date | null;
};

const BACKLOG_ID = /^backlog\s*id$/i;
const HALF_BAKED = /^half[-\s]?baked/i;
const REPORT = /^report$/i;
const SEVERITY = /^severity$/i;
const TYPE = /^type$/i;
const STATUS = /^status$/i;
const BUG_TYPE = /bug|ошибк|баг/i;

export function notionCardMeta(task: ImportedTask): NotionCardMeta | null {
  const ref = task.sourceRef;
  if (ref?.system !== "notion") return null;

  const fields = Object.entries(task.extraFields ?? {});
  const field = (pattern: RegExp) =>
    fields.find(([name]) => pattern.test(name))?.[1];
  const text = (pattern: RegExp) => {
    const value = field(pattern);
    if (typeof value === "number") return String(value);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const editedAt = Date.parse(ref.lastEditedTime);

  return {
    kind: BUG_TYPE.test(text(TYPE) ?? "") ? "bug" : "task",
    severity: text(SEVERITY),
    backlogId: text(BACKLOG_ID),
    halfBaked: field(HALF_BAKED) === true,
    report: text(REPORT),
    notionPageId: ref.pageId,
    notionStatus: text(STATUS),
    notionEditedAt: Number.isNaN(editedAt) ? null : new Date(editedAt),
  };
}

// backlog_id is unique per workspace. A second page with the same ID, or one a
// card outside this import already holds, keeps its card without the ID.
export function releaseTakenBacklogIds<T extends { meta: NotionCardMeta }>(
  rows: readonly T[],
  takenElsewhere: ReadonlySet<string>,
): { rows: T[]; dropped: string[] } {
  const seen = new Set<string>();
  const dropped: string[] = [];
  const kept = rows.map((row) => {
    const id = row.meta.backlogId;
    if (id === null) return row;
    if (seen.has(id) || takenElsewhere.has(id)) {
      dropped.push(id);
      return { ...row, meta: { ...row.meta, backlogId: null } };
    }
    seen.add(id);
    return row;
  });
  return { rows: kept, dropped };
}
