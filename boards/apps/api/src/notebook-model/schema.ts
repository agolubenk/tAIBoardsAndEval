import { z } from "../openapi";

export const notebookModelSchema = z
  .object({
    baseUrl: z.string(),
    model: z.string().nullable(),
    embedModel: z.string(),
    dailyMax: z.number().int(),
    hasKey: z.boolean(),
    keySource: z.enum(["settings", "file"]).nullable().openapi({
      description:
        "Where the model key comes from: these settings, or the server's key file. The key itself is never returned.",
    }),
    keyUnreadable: z.boolean().openapi({
      description:
        "A key is stored but the server's settings key cannot open it; enter the key again.",
    }),
    canStoreKey: z.boolean().openapi({
      description:
        "The server has a settings encryption key, so a model key can be saved here.",
    }),
    callsToday: z.number().int(),
    usage: z.array(
      z.object({
        workspaceId: z.string(),
        name: z.string(),
        calls: z.number().int(),
      }),
    ),
  })
  .openapi("NotebookModelSettings");

const optionalText = (max: number) =>
  z.string().trim().min(1).max(max).nullable().optional();

export const updateNotebookModelBody = z
  .object({
    baseUrl: z.string().trim().url().max(500).nullable().optional(),
    model: optionalText(200),
    embedModel: optionalText(200),
    dailyMax: z.number().int().min(0).max(100_000).nullable().optional(),
    key: z.string().trim().min(1).max(500).nullable().optional().openapi({
      description:
        "A new model key; null removes the stored one, leaving it out keeps it.",
    }),
  })
  .openapi("UpdateNotebookModelSettings");

export type UpdateNotebookModel = z.infer<typeof updateNotebookModelBody>;
