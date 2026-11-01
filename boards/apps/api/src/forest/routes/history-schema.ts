import { pagingNumber, responseTimestamp, z } from "../../openapi";
import { HISTORY_PAGE_MAX } from "../history/card-history";
import { cardMetaSchema, cardParam } from "./card-schema";

export const historyQuery = z.object({
  take: pagingNumber(1, HISTORY_PAGE_MAX).optional(),
});

export const historyEntryParam = cardParam.extend({ historyId: z.string() });

const fieldChange = z.object({ from: z.unknown(), to: z.unknown() });

// One edit of a card (R-023): what it changed, field by field.
export const historyEntrySchema = z
  .object({
    id: z.string(),
    kind: z.enum(["task", "meta"]).openapi({
      description:
        "task: title, description, status, priority, assignee, dates. meta: the card fields.",
    }),
    revision: z.number().nullable().openapi({
      description: "task edits: the revision the edit replaced.",
    }),
    changes: z.record(z.string(), fieldChange),
    actorId: z.string().nullable().openapi({
      description:
        "The agent or t-boards session behind the edit; null for a person's edit on kaneo's routes (kaneo's activity names them).",
    }),
    createdAt: responseTimestamp,
  })
  .openapi("ForestCardHistoryEntry");

export const historySchema = z
  .object({ entries: z.array(historyEntrySchema) })
  .openapi("ForestCardHistory");

export const rollbackSchema = z
  .object({
    kind: z.enum(["task", "meta"]),
    revision: z.number().nullable().openapi({
      description: "task rollbacks: the card's revision after it.",
    }),
    meta: cardMetaSchema.nullable(),
  })
  .openapi("ForestCardRollback");
