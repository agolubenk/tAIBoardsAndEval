import { and, eq, inArray, or } from "drizzle-orm";
import db, { schema } from "../database";
import { cardMetaTable } from "../database/forest-schema";
import type { PlannedProduct } from "./products-plan-schema";

type RelationType = "subtask" | "blocks" | "related";
type PlannedLink = { source: string; target: string; type: RelationType };

export type LinkReport = {
  created: number;
  existing: number;
  skipped: string[];
};

// A subtask link runs parent → child, as the tree reads it.
export function plannedLinks(product: PlannedProduct): PlannedLink[] {
  return product.projects
    .flatMap((project) => project.cards)
    .flatMap((card) => [
      ...(card.parent
        ? [{ source: card.parent, target: card.key, type: "subtask" as const }]
        : []),
      ...card.blocks.map((target) => ({
        source: card.key,
        target,
        type: "blocks" as const,
      })),
      ...card.related.map((target) => ({
        source: card.key,
        target,
        type: "related" as const,
      })),
    ]);
}

const sameLink = (
  row: { sourceTaskId: string; targetTaskId: string; relationType: string },
  source: string,
  target: string,
  type: RelationType,
) =>
  row.relationType === type &&
  ((row.sourceTaskId === source && row.targetTaskId === target) ||
    (row.sourceTaskId === target && row.targetTaskId === source));

// Adds the planned links that are missing, like the cards: a link someone
// removed on the board comes back only if the plan still names it, and a card
// that already has another parent keeps it (one parent per card, spec §5.2).
export async function seedCardLinks(
  workspaceId: string,
  product: PlannedProduct,
): Promise<LinkReport> {
  const report: LinkReport = { created: 0, existing: 0, skipped: [] };
  const links = plannedLinks(product);
  if (!links.length) return report;

  const keys = [
    ...new Set(links.flatMap((link) => [link.source, link.target])),
  ];
  const cards = await db
    .select({ taskId: cardMetaTable.taskId, key: cardMetaTable.backlogId })
    .from(cardMetaTable)
    .where(
      and(
        eq(cardMetaTable.workspaceId, workspaceId),
        inArray(cardMetaTable.backlogId, keys),
      ),
    );
  const taskOf = new Map(cards.map((card) => [card.key, card.taskId]));
  const taskIds = [...taskOf.values()];

  await db.transaction(async (tx) => {
    const rows = taskIds.length
      ? await tx
          .select({
            sourceTaskId: schema.taskRelationTable.sourceTaskId,
            targetTaskId: schema.taskRelationTable.targetTaskId,
            relationType: schema.taskRelationTable.relationType,
          })
          .from(schema.taskRelationTable)
          .where(
            or(
              inArray(schema.taskRelationTable.sourceTaskId, taskIds),
              inArray(schema.taskRelationTable.targetTaskId, taskIds),
            ),
          )
      : [];

    for (const link of links) {
      const label = `${link.source} ${link.type} ${link.target}`;
      const source = taskOf.get(link.source);
      const target = taskOf.get(link.target);
      if (!source || !target) {
        report.skipped.push(`${label}: card missing`);
        continue;
      }
      if (rows.some((row) => sameLink(row, source, target, link.type))) {
        report.existing++;
        continue;
      }
      const otherParent =
        link.type === "subtask" &&
        rows.some(
          (row) =>
            row.relationType === "subtask" &&
            row.targetTaskId === target &&
            row.sourceTaskId !== source,
        );
      if (otherParent) {
        report.skipped.push(`${label}: card has another parent`);
        continue;
      }
      const relation = {
        sourceTaskId: source,
        targetTaskId: target,
        relationType: link.type,
      };
      await tx.insert(schema.taskRelationTable).values(relation);
      rows.push(relation);
      report.created++;
    }
  });
  return report;
}
