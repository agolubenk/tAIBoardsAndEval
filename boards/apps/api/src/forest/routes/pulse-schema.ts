import { pagingNumber, responseTimestamp, z } from "../../openapi";
import { pageQuery } from "./schema";

// R-090: the agents' feed and what is on fire.
export const journalQuery = pageQuery.extend({
  actor: z.enum(["agent", "all"]).optional().openapi({
    description: "agent (default) shows agents only; all adds people.",
  }),
  outcome: z.enum(["denied"]).optional().openapi({
    description: "denied keeps only refused actions.",
  }),
});

export const journalSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.string(),
        actorKind: z.string(),
        actorName: z.string(),
        action: z.string(),
        targetType: z.string(),
        targetId: z.string(),
        outcome: z.string(),
        detail: z.string().nullable(),
        createdAt: responseTimestamp,
        taskNumber: z.number().nullable(),
        taskTitle: z.string().nullable(),
        projectId: z.string().nullable(),
        projectName: z.string().nullable(),
      }),
    ),
    nextCursor: z.string().nullable(),
  })
  .openapi("ForestJournal");

export const firesQuery = z.object({
  take: pagingNumber(1, 100).optional(),
});

export const firesSchema = z
  .object({
    total: z.number(),
    items: z.array(
      z.object({
        taskId: z.string(),
        number: z.number().nullable(),
        title: z.string(),
        status: z.string(),
        priority: z.string(),
        kind: z.string().nullable(),
        severity: z.string().nullable(),
        projectId: z.string(),
        projectName: z.string(),
        createdAt: responseTimestamp,
        hot: z.boolean(),
      }),
    ),
  })
  .openapi("ForestFires");
