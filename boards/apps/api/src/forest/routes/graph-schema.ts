import { z } from "../../openapi";

// R-090: the links graph of cards, files and decisions.
export const graphSchema = z
  .object({
    cards: z.array(
      z.object({
        id: z.string(),
        number: z.number().nullable(),
        title: z.string(),
        status: z.string(),
        isCompleted: z.boolean(),
        isBug: z.boolean(),
        projectId: z.string(),
        projectName: z.string(),
        sectorIds: z.array(z.string()),
      }),
    ),
    files: z.array(z.object({ id: z.string(), path: z.string() })),
    decisions: z.array(z.object({ id: z.string(), ref: z.string() })),
    edges: z.array(
      z.object({
        source: z.string(),
        target: z.string(),
        type: z
          .enum(["subtask", "blocks", "related", "file", "decision"])
          .openapi({
            description:
              "subtask, blocks and related join cards (source → target); file and decision join a card to its node.",
          }),
      }),
    ),
    sectors: z.array(z.object({ id: z.string(), name: z.string() })),
    nextCursor: z.string().nullable(),
  })
  .openapi("ForestGraph");
