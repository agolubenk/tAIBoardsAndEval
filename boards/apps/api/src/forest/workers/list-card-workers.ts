import { and, desc, eq, gt, isNotNull } from "drizzle-orm";
import db from "../../database";
import {
  cardMetaTable,
  sessionWorkStateTable,
  taskLeaseTable,
} from "../../database/forest-schema";
import { projectTable, taskTable } from "../../database/schema";
import { projectAccessCondition } from "../../project-access/project-access-condition";
import { PAGE_MAX } from "../read/page-cursor";
import { type CardWorker, mergeCardWorkers } from "./merge-card-workers";

// Cards of a done project can all carry an executor; past this the board just
// stops naming the oldest ones.
const EXECUTORS_MAX = 1000;

// Who works on a project's cards, for the board: the live lease holder, the
// session whose working state names the card, and the executor the card's
// fields record. Three queries per board instead of one request per card.
export async function listCardWorkers(
  workspaceId: string,
  projectId: string,
  userId: string,
  now = new Date(),
): Promise<CardWorker[]> {
  const inProject = and(
    eq(taskTable.projectId, projectId),
    eq(projectTable.workspaceId, workspaceId),
    projectAccessCondition(userId, projectTable.id),
  );
  const [holders, sessions, executors] = await Promise.all([
    db
      .select({
        taskId: taskLeaseTable.taskId,
        name: taskLeaseTable.holderName,
        kind: taskLeaseTable.holderKind,
        until: taskLeaseTable.expiresAt,
      })
      .from(taskLeaseTable)
      .innerJoin(taskTable, eq(taskTable.id, taskLeaseTable.taskId))
      .innerJoin(projectTable, eq(projectTable.id, taskTable.projectId))
      .where(and(inProject, gt(taskLeaseTable.expiresAt, now)))
      .limit(PAGE_MAX),
    db
      .select({
        taskId: sessionWorkStateTable.taskId,
        name: sessionWorkStateTable.actorName,
        kind: sessionWorkStateTable.actorKind,
        step: sessionWorkStateTable.step,
        at: sessionWorkStateTable.updatedAt,
      })
      .from(sessionWorkStateTable)
      .innerJoin(taskTable, eq(taskTable.id, sessionWorkStateTable.taskId))
      .innerJoin(projectTable, eq(projectTable.id, taskTable.projectId))
      .where(and(inProject, eq(sessionWorkStateTable.workspaceId, workspaceId)))
      .orderBy(desc(sessionWorkStateTable.updatedAt))
      .limit(PAGE_MAX),
    db
      .select({
        taskId: cardMetaTable.taskId,
        executor: cardMetaTable.executor,
      })
      .from(cardMetaTable)
      .innerJoin(taskTable, eq(taskTable.id, cardMetaTable.taskId))
      .innerJoin(projectTable, eq(projectTable.id, taskTable.projectId))
      .where(and(inProject, isNotNull(cardMetaTable.executor)))
      .orderBy(desc(cardMetaTable.updatedAt))
      .limit(EXECUTORS_MAX),
  ]);
  return mergeCardWorkers(holders, sessions, executors);
}
