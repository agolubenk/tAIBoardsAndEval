import { nullableResponseTimestamp, responseTimestamp, z } from "../../openapi";
import { CONTEXT_LIMITS } from "../context/context-sections";
import { cardMetaSchema } from "./card-schema";

const relatedTaskSchema = z.object({
  id: z.string(),
  number: z.number().nullable(),
  title: z.string(),
  status: z.string(),
  isCompleted: z.boolean(),
});

// Everything an agent needs to pick up a card, in one read (R-031).
export const cardContextSchema = z
  .object({
    id: z.string(),
    number: z.number().nullable(),
    title: z.string(),
    status: z.string(),
    isCompleted: z.boolean(),
    priority: z.string(),
    assigneeName: z.string().nullable(),
    projectId: z.string(),
    projectName: z.string(),
    revision: z.number(),
    startDate: nullableResponseTimestamp,
    dueDate: nullableResponseTimestamp,
    createdAt: responseTimestamp,
    updatedAt: responseTimestamp,
    description: z.string().nullable(),
    labels: z.array(z.string()),
    meta: cardMetaSchema.omit({ taskId: true }),
    lease: z
      .object({
        holderName: z.string(),
        holderKind: z.string(),
        expiresAt: responseTimestamp,
      })
      .nullable()
      .openapi({ description: "The live lease, if someone works on it now." }),
    approvals: z
      .array(
        z.object({
          id: z.string(),
          action: z.string(),
          params: z.record(z.string(), z.string()).nullable(),
          reason: z.string().nullable(),
          requestedByName: z.string(),
          createdAt: responseTimestamp,
          expiresAt: responseTimestamp,
        }),
      )
      .openapi({
        description: `Pending requests for the owner's «да» on this card, newest first, at most ${CONTEXT_LIMITS.approvals}.`,
      }),
    relations: z
      .array(
        z.object({
          id: z.string(),
          relationType: z.string(),
          direction: z.enum(["outgoing", "incoming"]).openapi({
            description:
              "outgoing: this card is the relation's source (it blocks, it is the parent).",
          }),
          task: relatedTaskSchema,
          createdAt: responseTimestamp,
        }),
      )
      .openapi({
        description: `Linked cards the caller can see, at most ${CONTEXT_LIMITS.relations}.`,
      }),
    comments: z
      .array(
        z.object({
          id: z.string(),
          authorName: z.string(),
          content: z.string(),
          createdAt: responseTimestamp,
          updatedAt: responseTimestamp,
        }),
      )
      .openapi({
        description: `The latest comments, newest first, at most ${CONTEXT_LIMITS.comments}.`,
      }),
    history: z
      .array(
        z.object({
          id: z.string(),
          kind: z.enum(["task", "meta"]),
          fields: z.array(z.string()),
          actorId: z.string().nullable(),
          createdAt: responseTimestamp,
        }),
      )
      .openapi({
        description: `The latest edits, newest first, at most ${CONTEXT_LIMITS.history}: which fields changed, not the values (those are in the card history).`,
      }),
    truncated: z
      .array(z.enum(["approvals", "relations", "comments", "history"]))
      .openapi({
        description:
          "Sections that had more than the pack holds; read them in full from their own endpoints.",
      }),
  })
  .openapi("ForestCardContext");
