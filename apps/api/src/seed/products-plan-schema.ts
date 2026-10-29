import { z } from "zod";
import { CARD_KINDS } from "../forest/card/card-fields";
import { PROJECT_PROCESSES } from "../project/project-processes";
import { VALID_PRIORITIES } from "../task/validate-task-fields";

const cardKey = z.string().regex(/^[A-Z]{2,5}-\d{3}$/);
const text = (max: number) => z.string().trim().min(1).max(max);

// A card's links name other cards of the same product by key: the forest never
// crosses a product boundary (R-002, R-029). The rest fills the card's meta,
// within the limits the meta API accepts (forest/card/card-patch.ts).
const cardSchema = z.strictObject({
  key: cardKey,
  title: z.string().min(1).max(200),
  // Checked against the project's process below.
  status: z.string().min(1).max(40),
  priority: z.enum(VALID_PRIORITIES),
  description: z.string().max(4000).default(""),
  parent: cardKey.optional(),
  blocks: z.array(cardKey).max(30).default([]),
  related: z.array(cardKey).max(30).default([]),
  kind: z.enum(CARD_KINDS).default("task"),
  severity: text(32).optional(),
  halfBaked: z.boolean().default(false),
  report: text(20_000).optional(),
  executor: text(200).optional(),
  branch: text(200).optional(),
  pullRequests: z.array(text(500)).max(20).default([]),
  files: z.array(text(500)).max(200).default([]),
  contextPack: text(2000).optional(),
});

const projectSchema = z
  .object({
    key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
    name: z.string().min(1).max(80),
    icon: z.string().min(1).max(40),
    process: z.enum(["tasks", "bugs"]).default("tasks"),
    cards: z.array(cardSchema).max(200),
  })
  .superRefine((project, ctx) => {
    const slugs = new Set<string>(
      PROJECT_PROCESSES[project.process].map((column) => column.slug),
    );
    project.cards.forEach((card, index) => {
      if (!slugs.has(card.status))
        ctx.addIssue({
          code: "custom",
          path: ["cards", index, "status"],
          message: `${card.key}: ${card.status} is not a column of the ${project.process} process`,
        });
    });
  });

const productSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name: z.string().min(1).max(80),
  description: z.string().max(2000).default(""),
  projects: z.array(projectSchema).max(20),
});

export type PlannedProduct = z.infer<typeof productSchema>;
export type PlannedCard = z.infer<typeof cardSchema>;
export type PlannedProject = z.infer<typeof projectSchema>;

function parentCycle(cards: PlannedCard[]) {
  const parentOf = new Map(cards.map((card) => [card.key, card.parent]));
  for (const card of cards) {
    const seen = new Set<string>();
    for (let key: string | undefined = card.key; key; key = parentOf.get(key)) {
      if (seen.has(key)) return card.key;
      seen.add(key);
    }
  }
  return null;
}

function linkIssues(product: PlannedProduct) {
  const cards = product.projects.flatMap((project) => project.cards);
  const keys = new Set<string>();
  const issues: string[] = [];
  for (const card of cards) {
    if (keys.has(card.key)) issues.push(`${card.key}: duplicate key`);
    keys.add(card.key);
  }
  for (const card of cards) {
    const refs = [card.parent, ...card.blocks, ...card.related];
    for (const ref of refs) {
      if (!ref) continue;
      if (ref === card.key) issues.push(`${card.key}: links to itself`);
      else if (!keys.has(ref))
        issues.push(`${card.key}: ${ref} is not a card of ${product.slug}`);
    }
  }
  const cycle = parentCycle(cards);
  if (cycle) issues.push(`${cycle}: parent chain loops`);
  return issues;
}

export const productsPlanSchema = z
  .object({
    version: z.string(),
    products: z.array(productSchema).max(10),
  })
  .superRefine((plan, ctx) => {
    plan.products.forEach((product, index) => {
      for (const message of linkIssues(product)) {
        ctx.addIssue({ code: "custom", path: ["products", index], message });
      }
    });
  });

export type ProductsPlan = z.infer<typeof productsPlanSchema>;
