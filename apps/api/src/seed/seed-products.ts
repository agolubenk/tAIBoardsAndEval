import { and, eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "../database";
import { cardMetaTable } from "../database/forest-schema";
import { detectSectors } from "../forest/sector/detect-sectors";
import { insertProject } from "../project/controllers/insert-project";
import { claimTaskNumber } from "../task/controllers/claim-task-numbers";
import { nextTaskPosition } from "../task/controllers/next-task-position";
import { seedDefaultWorkspaceRoles } from "../utils/seed-default-workspace-roles";
import type {
  PlannedCard,
  PlannedProduct,
  PlannedProject,
  ProductsPlan,
} from "./products-plan-schema";
import { ensureProcessColumns } from "./ensure-process-columns";
import { type LinkReport, seedCardLinks } from "./seed-card-links";
import { syncSeededCards } from "./sync-seeded-cards";

export { type ProductsPlan, productsPlanSchema } from "./products-plan-schema";

// Products (spec: a product is a workspace with a hard data boundary, its
// projects are repositories) and their starting cards, from a plan kept in git
// (deploy/vps/seed/products.json). Adds what is missing; a card already seeded
// keeps whatever people did to it since, matched by its backlog id, and only a
// card nobody has edited follows the plan (sync-seeded-cards).
export const SEED_ACTOR = "seed:products";

export type SeedReport = {
  workspaces: { created: string[]; existing: string[] };
  projects: { created: string[]; existing: string[] };
  columns: { added: number };
  cards: { created: number; existing: number; synced: number };
  agentFields: { filled: number };
  links: LinkReport;
  sectors: number;
};

async function ensureWorkspace(product: PlannedProduct, ownerId: string) {
  const [found] = await db
    .select()
    .from(schema.workspaceTable)
    .where(eq(schema.workspaceTable.slug, product.slug));
  if (found) return { workspace: found, created: false };

  const workspace = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.workspaceTable)
      .values({
        name: product.name,
        slug: product.slug,
        description: product.description || null,
        createdAt: new Date(),
      })
      .returning();
    if (!row)
      throw new Error(`workspace ${product.slug}: insert returned no row`);
    await tx.insert(schema.workspaceUserTable).values({
      workspaceId: row.id,
      userId: ownerId,
      role: "owner",
      joinedAt: new Date(),
    });
    return row;
  });
  return { workspace, created: true };
}

async function ensureProject(
  workspaceId: string,
  project: PlannedProject,
  ownerId: string,
) {
  const [found] = await db
    .select()
    .from(schema.projectTable)
    .where(
      and(
        eq(schema.projectTable.workspaceId, workspaceId),
        sql`lower(${schema.projectTable.slug}) = lower(${project.key})`,
      ),
    );
  if (found) return { project: found, created: false };

  const created = await db.transaction((tx) =>
    insertProject(tx, {
      workspaceId,
      name: project.name,
      icon: project.icon,
      slug: project.key,
      userId: ownerId,
      process: project.process,
    }),
  );
  if (!created)
    throw new Error(`project ${project.key}: insert returned no row`);
  return { project: created, created: true };
}

async function insertCard(
  workspaceId: string,
  projectId: string,
  card: PlannedCard,
) {
  await db.transaction(async (tx) => {
    const [column] = await tx
      .select({ id: schema.columnTable.id })
      .from(schema.columnTable)
      .where(
        and(
          eq(schema.columnTable.projectId, projectId),
          eq(schema.columnTable.slug, card.status),
        ),
      );
    const number = await claimTaskNumber(projectId, tx);
    const position = await nextTaskPosition(
      tx,
      projectId,
      card.status,
      column?.id ?? null,
    );
    const [task] = await tx
      .insert(schema.taskTable)
      .values({
        projectId,
        title: card.title,
        description: card.description,
        status: card.status,
        columnId: column?.id ?? null,
        priority: card.priority,
        number,
        position,
      })
      .returning({ id: schema.taskTable.id });
    if (!task) throw new Error(`card ${card.key}: insert returned no row`);
    await tx.insert(cardMetaTable).values({
      taskId: task.id,
      workspaceId,
      backlogId: card.key,
      kind: card.kind,
      severity: card.severity ?? null,
      halfBaked: card.halfBaked,
      report: card.report ?? null,
      ...agentFields(card),
      updatedBy: SEED_ACTOR,
    });
  });
}

function agentFields(card: PlannedCard) {
  return {
    executor: card.executor ?? null,
    branch: card.branch ?? null,
    pullRequests: card.pullRequests,
    files: card.files,
    contextPack: card.contextPack ?? null,
  };
}

const hasAgentFields = (card: PlannedCard) =>
  Boolean(
    card.executor ||
    card.branch ||
    card.contextPack ||
    card.pullRequests.length ||
    card.files.length,
  );

// A card seeded before the plan knew its agent fields gets them, but only
// where the board still has nothing: what an agent or person wrote stays.
async function fillAgentFields(workspaceId: string, card: PlannedCard) {
  const fields = agentFields(card);
  const updated = await db
    .update(cardMetaTable)
    .set({
      executor: sql`coalesce(${cardMetaTable.executor}, ${fields.executor})`,
      branch: sql`coalesce(${cardMetaTable.branch}, ${fields.branch})`,
      contextPack: sql`coalesce(${cardMetaTable.contextPack}, ${fields.contextPack})`,
      pullRequests: sql`case when ${cardMetaTable.pullRequests} = '[]'::jsonb then ${JSON.stringify(fields.pullRequests)}::jsonb else ${cardMetaTable.pullRequests} end`,
      files: sql`case when ${cardMetaTable.files} = '[]'::jsonb then ${JSON.stringify(fields.files)}::jsonb else ${cardMetaTable.files} end`,
    })
    .where(
      and(
        eq(cardMetaTable.workspaceId, workspaceId),
        eq(cardMetaTable.backlogId, card.key),
        sql`(${cardMetaTable.executor} is null and ${fields.executor}::text is not null
          or ${cardMetaTable.branch} is null and ${fields.branch}::text is not null
          or ${cardMetaTable.contextPack} is null and ${fields.contextPack}::text is not null
          or ${cardMetaTable.pullRequests} = '[]'::jsonb and ${fields.pullRequests.length} > 0
          or ${cardMetaTable.files} = '[]'::jsonb and ${fields.files.length} > 0)`,
      ),
    )
    .returning({ taskId: cardMetaTable.taskId });
  return updated.length;
}

export async function seedProducts(
  plan: ProductsPlan,
  ownerEmail: string,
): Promise<SeedReport> {
  const [owner] = await db
    .select({ id: schema.userTable.id })
    .from(schema.userTable)
    .where(eq(schema.userTable.email, ownerEmail));
  if (!owner) throw new Error(`no user ${ownerEmail}: seed the admin first`);

  const report: SeedReport = {
    workspaces: { created: [], existing: [] },
    projects: { created: [], existing: [] },
    columns: { added: 0 },
    cards: { created: 0, existing: 0, synced: 0 },
    agentFields: { filled: 0 },
    links: { created: 0, existing: 0, skipped: [] },
    sectors: 0,
  };

  for (const product of plan.products) {
    const { workspace, created } = await ensureWorkspace(product, owner.id);
    report.workspaces[created ? "created" : "existing"].push(product.slug);

    const keys = product.projects.flatMap((p) => p.cards.map((c) => c.key));
    const seeded = keys.length
      ? await db
          .select({ backlogId: cardMetaTable.backlogId })
          .from(cardMetaTable)
          .where(
            and(
              eq(cardMetaTable.workspaceId, workspace.id),
              inArray(cardMetaTable.backlogId, keys),
            ),
          )
      : [];
    const present = new Set(seeded.map((row) => row.backlogId));

    for (const planned of product.projects) {
      const { project, created: projectCreated } = await ensureProject(
        workspace.id,
        planned,
        owner.id,
      );
      report.projects[projectCreated ? "created" : "existing"].push(
        `${product.slug}/${planned.key}`,
      );
      if (!projectCreated)
        report.columns.added += await ensureProcessColumns(
          project.id,
          planned.process,
        );
      for (const card of planned.cards) {
        if (present.has(card.key)) {
          report.cards.existing++;
          if (hasAgentFields(card))
            report.agentFields.filled += await fillAgentFields(
              workspace.id,
              card,
            );
          continue;
        }
        await insertCard(workspace.id, project.id, card);
        report.cards.created++;
      }
    }

    // After the columns: the plan may move a card into one the process added.
    report.cards.synced += await syncSeededCards(
      workspace.id,
      product.projects
        .flatMap((p) => p.cards)
        .filter((c) => present.has(c.key)),
      SEED_ACTOR,
    );

    const links = await seedCardLinks(workspace.id, product);
    report.links.created += links.created;
    report.links.existing += links.existing;
    report.links.skipped.push(...links.skipped);
    // New links can join trees into sectors (R-029); recompute only then.
    if (links.created)
      report.sectors += (await detectSectors(workspace.id)).length;
  }

  // The default viewer/member/admin roles a workspace needs; the API backfills
  // them on start too, this saves the restart.
  await seedDefaultWorkspaceRoles();
  return report;
}
