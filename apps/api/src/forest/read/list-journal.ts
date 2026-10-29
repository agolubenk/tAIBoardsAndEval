import {
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import db from "../../database";
import { agentJournalTable } from "../../database/forest-schema";
import { projectTable, taskTable } from "../../database/schema";
import { projectAccessCondition } from "../../project-access/project-access-condition";
import { isProjectAccessRestricted } from "../../project-access/is-project-access-restricted";
import { decodeCursor, encodeCursor, pageSize } from "./page-cursor";

export type JournalActor = "agent" | "all";

const CARD_TARGETS = ["task", "project"];

// What agents and people did on the board, newest first (R-036, R-090). An
// entry about a card or project shows only to those who may open that project;
// once its card is gone (felled, deleted), only to those who may open every one.
export async function listJournal({
  workspaceId,
  userId,
  actor = "agent",
  denied = false,
  cursor,
  take,
}: {
  workspaceId: string;
  userId: string;
  actor?: JournalActor;
  denied?: boolean;
  cursor?: string;
  take?: number;
}) {
  const limit = pageSize(take, 30);
  const after = decodeCursor(cursor);
  const restricted = await isProjectAccessRestricted(workspaceId, userId);
  const journal = agentJournalTable;
  const rows = await db
    .select({
      id: journal.id,
      actorKind: journal.actorKind,
      actorName: journal.actorName,
      action: journal.action,
      targetType: journal.targetType,
      targetId: journal.targetId,
      outcome: journal.outcome,
      detail: journal.detail,
      createdAt: journal.createdAt,
      taskNumber: taskTable.number,
      taskTitle: taskTable.title,
      projectId: projectTable.id,
      projectName: projectTable.name,
    })
    .from(journal)
    .leftJoin(
      taskTable,
      and(eq(journal.targetType, "task"), eq(taskTable.id, journal.targetId)),
    )
    .leftJoin(
      projectTable,
      and(
        eq(projectTable.workspaceId, workspaceId),
        eq(
          projectTable.id,
          sql`coalesce(${taskTable.projectId}, case when ${journal.targetType} = 'project' then ${journal.targetId} end)`,
        ),
      ),
    )
    .where(
      and(
        eq(journal.workspaceId, workspaceId),
        actor === "agent" ? eq(journal.actorKind, "agent") : undefined,
        denied ? eq(journal.outcome, "denied") : undefined,
        or(
          notInArray(journal.targetType, CARD_TARGETS),
          // The access check passes for a missing project, so ask for one.
          and(
            isNotNull(projectTable.id),
            projectAccessCondition(userId, projectTable.id),
          ),
          restricted ? undefined : isNull(projectTable.id),
        ),
        after
          ? or(
              lt(journal.createdAt, after.at),
              and(eq(journal.createdAt, after.at), lt(journal.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(journal.createdAt), desc(journal.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ at: last.createdAt, id: last.id })
        : null,
  };
}
