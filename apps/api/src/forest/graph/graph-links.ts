import { and, eq, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import db from "../../database";
import {
  projectTable,
  taskRelationTable,
  taskTable,
} from "../../database/schema";
import { projectAccessCondition } from "../../project-access/project-access-condition";
import type { PageCursor } from "../read/page-cursor";
import { createdMs, cursorRow } from "./graph-cards";

export const LINKS_MAX = 1000;

// Links of the page's cards to cards the reader may open and has already got:
// on this page or an earlier one. A link to a later card comes with that card,
// so every link arrives once, on the page of its newer end.
export function cardLinks({
  workspaceId,
  userId,
  cardIds,
  after,
}: {
  workspaceId: string;
  userId: string;
  cardIds: string[];
  after: PageCursor | null;
}) {
  if (!cardIds.length) return [];
  const relation = taskRelationTable;
  const other = alias(taskTable, "graph_other");
  const otherProject = alias(projectTable, "graph_other_project");
  const fromPage = inArray(relation.sourceTaskId, cardIds);
  return db
    .select({
      source: relation.sourceTaskId,
      target: relation.targetTaskId,
      type: relation.relationType,
    })
    .from(relation)
    .innerJoin(
      other,
      eq(
        other.id,
        sql`case when ${fromPage} then ${relation.targetTaskId} else ${relation.sourceTaskId} end`,
      ),
    )
    .innerJoin(otherProject, eq(otherProject.id, other.projectId))
    .where(
      and(
        or(fromPage, inArray(relation.targetTaskId, cardIds)),
        eq(otherProject.workspaceId, workspaceId),
        projectAccessCondition(userId, otherProject.id),
        or(
          inArray(other.id, cardIds),
          after
            ? // The cursor's own card came on the last page, so >=.
              sql`(${createdMs(other.createdAt)}, ${other.id}) >= ${cursorRow(after)}`
            : undefined,
        ),
      ),
    )
    .limit(LINKS_MAX);
}
