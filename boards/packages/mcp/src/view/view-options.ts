import { z } from "zod";
import { BUDGET_MAX, BUDGET_MIN } from "./fit-to-budget.js";

// Read modes of R-031, mixed into the input schema of every read tool.
export const viewOptionsShape = {
  fields: z
    .array(z.string().trim().min(1).max(64))
    .max(40)
    .optional()
    .describe(
      "Keep only these fields of each entity (id and child lists stay).",
    ),
  summary: z
    .boolean()
    .optional()
    .describe("Shorten long text fields to their first paragraph."),
  since: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe("Only entities changed after this ISO time."),
  ifNoneMatch: z
    .string()
    .max(64)
    .optional()
    .describe(
      "The etag of a previous answer; an unchanged result comes back without a body.",
    ),
  budget: z
    .number()
    .int()
    .min(BUDGET_MIN)
    .max(BUDGET_MAX)
    .optional()
    .describe(
      `Token budget of the answer, ${BUDGET_MIN}–${BUDGET_MAX} (default ${BUDGET_MAX}); a longer answer is cut and says how to get the rest.`,
    ),
  format: z
    .enum(["toon", "json"])
    .optional()
    .describe("Wire format of the answer."),
};

const viewOptionsSchema = z.object(viewOptionsShape);
export type ViewOptions = z.output<typeof viewOptionsSchema>;

const VIEW_KEYS = Object.keys(viewOptionsShape) as (keyof ViewOptions)[];

// The args are already parsed by a schema extended with viewOptionsShape.
export function splitView<T extends Record<string, unknown>>(
  args: T,
): { view: ViewOptions; rest: Omit<T, keyof ViewOptions> } {
  const view: Record<string, unknown> = {};
  const rest: Record<string, unknown> = { ...args };
  for (const key of VIEW_KEYS) {
    if (args[key] !== undefined) view[key] = args[key];
    delete rest[key];
  }
  return {
    view: view as ViewOptions,
    rest: rest as Omit<T, keyof ViewOptions>,
  };
}
