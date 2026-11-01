import { z } from "../../openapi";
import { CARD_KINDS, type CardField } from "./card-fields";

const text = (max: number) => z.string().trim().min(1).max(max);

export const cardMetaPatch = z
  .object({
    kind: z.enum(CARD_KINDS).optional().openapi({
      description: "bug: a card from the Notion «Ошибки» board.",
    }),
    severity: text(32).nullable().optional(),
    backlogId: z
      .string()
      .regex(/^[\p{L}\p{N}._-]{1,64}$/u)
      .nullable()
      .optional()
      .openapi({ description: "Notion Backlog ID, unique in the workspace." }),
    halfBaked: z.boolean().optional().openapi({
      description:
        "A raw idea: agents do not take it into work. Only the owner's own session changes it.",
    }),
    report: z.string().max(20_000).nullable().optional(),
    executor: text(200).nullable().optional(),
    branch: text(200).nullable().optional(),
    pullRequests: z.array(text(500)).max(20).optional(),
    files: z.array(text(500)).max(200).optional().openapi({
      description: "Touched files, path or path:line.",
    }),
    tokens: z.number().int().min(0).nullable().optional(),
    costUsd: z.number().min(0).max(1e8).nullable().optional(),
    contextPack: text(2000).nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "send at least one field",
  });

export type CardMetaPatch = z.output<typeof cardMetaPatch>;

export function patchFields(patch: CardMetaPatch) {
  return Object.keys(patch) as CardField[];
}
