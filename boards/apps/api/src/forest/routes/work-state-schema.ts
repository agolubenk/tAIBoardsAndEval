import { responseTimestamp, z } from "../../openapi";

// R-037: a session's working state on the board.
export const workStateBody = z
  .object({
    taskId: z.string().max(200).nullish().openapi({
      description: "The card the session works on; null when none.",
    }),
    step: z.string().trim().min(1).max(500).openapi({
      description: "What the session is doing now, in a sentence.",
    }),
    branch: z.string().trim().min(1).max(200).nullish(),
    waiting: z.string().trim().min(1).max(500).nullish().openapi({
      description: "What the session waits for: a review, an answer, a run.",
    }),
  })
  .openapi("ForestWorkStateInput");

export const workStateSavedSchema = z
  .object({
    taskId: z.string().nullable(),
    step: z.string(),
    branch: z.string().nullable(),
    waiting: z.string().nullable(),
    updatedAt: responseTimestamp,
  })
  .openapi("ForestWorkStateSaved");

export const workStateListSchema = z
  .array(
    z.object({
      actorName: z.string(),
      actorKind: z.string(),
      step: z.string(),
      branch: z.string().nullable(),
      waiting: z.string().nullable(),
      updatedAt: responseTimestamp,
      taskId: z.string().nullable(),
      number: z.number().nullable(),
      title: z.string().nullable(),
      projectId: z.string().nullable(),
      projectName: z.string().nullable(),
    }),
  )
  .openapi("ForestWorkState");
