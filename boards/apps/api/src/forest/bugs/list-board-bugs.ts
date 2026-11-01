import { and, desc, eq } from "drizzle-orm";
import db from "../../database";
import { cardMetaTable } from "../../database/forest-schema";
import { projectTable, taskTable } from "../../database/schema";
import { projectAccessCondition } from "../../project-access/project-access-condition";

// A board of bugs past this still opens; the oldest just lose their mark.
const BUGS_MAX = 1000;

// The board's bugs: cards of kind "bug" among the project's tasks, in the same
// columns (owner, 30.10). One query per board instead of the meta per card.
export async function listBoardBugs(
  workspaceId: string,
  projectId: string,
  userId: string,
) {
  return db
    .select({ taskId: cardMetaTable.taskId, severity: cardMetaTable.severity })
    .from(cardMetaTable)
    .innerJoin(taskTable, eq(taskTable.id, cardMetaTable.taskId))
    .innerJoin(projectTable, eq(projectTable.id, taskTable.projectId))
    .where(
      and(
        eq(taskTable.projectId, projectId),
        eq(projectTable.workspaceId, workspaceId),
        projectAccessCondition(userId, projectTable.id),
        eq(cardMetaTable.kind, "bug"),
      ),
    )
    .orderBy(desc(taskTable.createdAt))
    .limit(BUGS_MAX);
}
