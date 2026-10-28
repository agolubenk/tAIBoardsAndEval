import { eq, sql } from "drizzle-orm";
import db from "../../database";
import {
  notebookChunkTable,
  notebookSourceTable,
} from "../../database/notebook-schema";
import { isWorkerOnline, workerLastSeen } from "../embed/embed-queue";
import { cloudCallsToday } from "../chat/ask-notebook";
import { notebookLlmConfig, readLlmKey } from "../llm/llm-config";
import { notebookEmbedModel } from "../notebook-config";

export async function notebookStatus(workspaceId: string) {
  const model = notebookEmbedModel();
  const [[sources], [chunks]] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(notebookSourceTable)
      .where(eq(notebookSourceTable.workspaceId, workspaceId)),
    db
      .select({
        count: sql<number>`count(*)::int`,
        embedded: sql<number>`count(*) filter (where ${notebookChunkTable.embedModel} = ${model} and ${notebookChunkTable.embedding} is not null)::int`,
      })
      .from(notebookChunkTable)
      .where(eq(notebookChunkTable.workspaceId, workspaceId)),
  ]);
  const seen = workerLastSeen(workspaceId);
  const llm = notebookLlmConfig();
  return {
    model,
    workerOnline: isWorkerOnline(workspaceId),
    workerSeenAt: seen === null ? null : new Date(seen),
    sources: sources?.count ?? 0,
    chunks: chunks?.count ?? 0,
    embedded: chunks?.embedded ?? 0,
    llm: {
      configured: llm !== null && readLlmKey(llm) !== null,
      model: llm?.model ?? null,
      callsToday: await cloudCallsToday(),
      dailyMax: llm?.dailyMax ?? null,
    },
  };
}
