import { z } from "../../openapi";

export const bugsQuery = z.object({
  projectId: z.string().min(1).openapi({
    description: "The project whose board asks.",
  }),
});

export const bugsSchema = z
  .array(
    z.object({
      taskId: z.string(),
      severity: z.string().nullable().openapi({
        description: "How bad the bug is, as its card records it.",
      }),
    }),
  )
  .openapi("ForestBoardBugs");
