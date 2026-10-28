import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import db, { schema } from "../database";
import { cardMetaTable } from "../database/forest-schema";
import { insertProject } from "../project/controllers/insert-project";
import { claimTaskNumber } from "../task/controllers/claim-task-numbers";
import { nextTaskPosition } from "../task/controllers/next-task-position";
import { VALID_PRIORITIES } from "../task/validate-task-fields";
import { seedDefaultWorkspaceRoles } from "../utils/seed-default-workspace-roles";

// Products (spec: a product is a workspace with a hard data boundary, its
// projects are repositories) and their starting cards, from a plan kept in git
// (deploy/vps/seed/products.json). Only adds what is missing: a card already
// seeded keeps whatever people did to it since, matched by its backlog id.
export const SEED_ACTOR = "seed:products";

const cardSchema = z.object({
  key: z.string().regex(/^[A-Z]{2,5}-\d{3}$/),
  title: z.string().min(1).max(200),
  status: z.enum(["to-do", "in-progress", "in-review", "done"]),
  priority: z.enum(VALID_PRIORITIES),
  description: z.string().max(4000).default(""),
});

const projectSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
  name: z.string().min(1).max(80),
  icon: z.string().min(1).max(40),
  cards: z.array(cardSchema).max(200),
});

export const productsPlanSchema = z.object({
  version: z.string(),
  products: z
    .array(
      z.object({
        slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
        name: z.string().min(1).max(80),
        description: z.string().max(2000).default(""),
        projects: z.array(projectSchema).max(20),
      }),
    )
    .max(10),
});

export type ProductsPlan = z.infer<typeof productsPlanSchema>;
type PlannedCard = z.infer<typeof cardSchema>;

export type SeedReport = {
  workspaces: { created: string[]; existing: string[] };
  projects: { created: string[]; existing: string[] };
  cards: { created: number; existing: number };
};

async function ensureWorkspace(
  product: ProductsPlan["products"][number],
  ownerId: string,
) {
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
  project: z.infer<typeof projectSchema>,
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
      updatedBy: SEED_ACTOR,
    });
  });
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
    cards: { created: 0, existing: 0 },
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
      for (const card of planned.cards) {
        if (present.has(card.key)) {
          report.cards.existing++;
          continue;
        }
        await insertCard(workspace.id, project.id, card);
        report.cards.created++;
      }
    }
  }

  // The default viewer/member/admin roles a workspace needs; the API backfills
  // them on start too, this saves the restart.
  await seedDefaultWorkspaceRoles();
  return report;
}
