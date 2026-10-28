import db from "../database";
import { agentJournalTable } from "../database/forest-schema";
import type { ForestActor } from "./actor";

type Writer = Pick<typeof db, "insert">;

export type JournalEntry = {
  workspaceId: string | null;
  actor: ForestActor;
  action: string;
  targetType: string;
  targetId: string;
  outcome: "allowed" | "denied";
  detail?: string;
};

export async function writeJournal(entry: JournalEntry, writer: Writer = db) {
  await writer.insert(agentJournalTable).values({
    workspaceId: entry.workspaceId,
    actorKind: entry.actor.kind,
    actorId: entry.actor.id,
    actorName: entry.actor.name,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    outcome: entry.outcome,
    detail: entry.detail?.slice(0, 2000),
  });
}
