import { responseTimestamp, z } from "../../openapi";

export const workersQuery = z.object({
  projectId: z.string().min(1).openapi({
    description: "The project whose board asks.",
  }),
});

export const workersSchema = z
  .array(
    z.object({
      taskId: z.string(),
      holder: z
        .object({
          name: z.string(),
          kind: z.string(),
          until: responseTimestamp,
        })
        .nullable()
        .openapi({ description: "Who holds the card's lease now." }),
      session: z
        .object({
          name: z.string(),
          kind: z.string(),
          step: z.string(),
          at: responseTimestamp,
        })
        .nullable()
        .openapi({
          description: "The latest session whose working state names the card.",
        }),
      executor: z.string().nullable().openapi({
        description: "Who the card's fields say did or does the work.",
      }),
    }),
  )
  .openapi("ForestCardWorkers");
