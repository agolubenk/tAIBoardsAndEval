import { PIPELINE_TOGGLE_NAMES, type PipelineToggle } from "@kaneo/permissions";
import { z } from "../openapi";

const toggleShape = Object.fromEntries(
  PIPELINE_TOGGLE_NAMES.map((name) => [name, z.boolean()]),
) as Record<PipelineToggle, z.ZodBoolean>;

export const pipelineSettingsSchema = z
  .object({
    automation: z.boolean().openapi({
      description:
        "Master switch: off stops every automated part below without losing its value.",
    }),
    toggles: z.object(toggleShape).openapi({
      description:
        "Automated parts of the process, each enforced where it runs (API, the layer's hooks and tools).",
    }),
    updatedAt: z.string().nullable(),
    updatedBy: z.string().nullable(),
  })
  .openapi("PipelineSettings");

export const updatePipelineSettingsBody = z
  .object({
    automation: z.boolean().optional(),
    toggles: z.object(toggleShape).partial().strict().optional(),
  })
  .strict()
  .openapi("UpdatePipelineSettings");

export const workspaceIdParam = z.object({
  workspaceId: z
    .string()
    .min(1)
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});
