import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { cardMetaTable } from "../../apps/api/src/database/forest-schema";
import {
  productsPlanSchema,
  seedProducts,
} from "../../apps/api/src/seed/seed-products";
import { resetTestDatabase } from "./helpers/database";

const PLAN = resolve(__dirname, "../../deploy/vps/seed/products.json");
const OWNER = "admin@t-boards.local";

const plan = () =>
  productsPlanSchema.parse(JSON.parse(readFileSync(PLAN, "utf8")));

describe("API integration: products seed", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("refuses to seed before the admin exists", async () => {
    await expect(seedProducts(plan(), OWNER)).rejects.toThrow(/seed the admin/);
  });

  it("creates the three products with projects and cards, then only keeps them", async () => {
    const [owner] = await db
      .insert(schema.userTable)
      .values({ name: "admin", email: OWNER, emailVerified: true })
      .returning();
    const planned = plan();
    const cardCount = planned.products
      .flatMap((p) => p.projects)
      .reduce((sum, p) => sum + p.cards.length, 0);

    const first = await seedProducts(planned, OWNER);
    expect(first.workspaces.created).toEqual([
      "hr-helper-lavaeon",
      "aiboards-eval",
      "financial-terminal",
    ]);
    expect(first.cards.created).toBe(cardCount);

    const workspaces = await db
      .select({
        id: schema.workspaceTable.id,
        name: schema.workspaceTable.name,
        role: schema.workspaceUserTable.role,
      })
      .from(schema.workspaceTable)
      .innerJoin(
        schema.workspaceUserTable,
        eq(schema.workspaceUserTable.workspaceId, schema.workspaceTable.id),
      )
      .where(eq(schema.workspaceUserTable.userId, owner.id));
    expect(workspaces.map((w) => w.name).sort()).toEqual([
      "Financial terminal",
      "HR Helper / Lavaeon",
      "aiBoards&eval",
    ]);
    expect(new Set(workspaces.map((w) => w.role))).toEqual(new Set(["owner"]));
    for (const { id } of workspaces) {
      const roles = await db.$count(
        schema.workspaceRoleTable,
        eq(schema.workspaceRoleTable.workspaceId, id),
      );
      expect(roles).toBeGreaterThan(0);
    }

    const aiBoards = workspaces.find((w) => w.name === "aiBoards&eval");
    const [tb] = await db
      .select()
      .from(schema.projectTable)
      .where(
        and(
          eq(schema.projectTable.workspaceId, aiBoards?.id ?? ""),
          eq(schema.projectTable.slug, "TB"),
        ),
      );
    expect(
      await db.$count(
        schema.columnTable,
        eq(schema.columnTable.projectId, tb.id),
      ),
    ).toBe(4);
    const [card] = await db
      .select({
        title: schema.taskTable.title,
        status: schema.taskTable.status,
        number: schema.taskTable.number,
        columnSlug: schema.columnTable.slug,
      })
      .from(cardMetaTable)
      .innerJoin(
        schema.taskTable,
        eq(schema.taskTable.id, cardMetaTable.taskId),
      )
      .innerJoin(
        schema.columnTable,
        eq(schema.columnTable.id, schema.taskTable.columnId),
      )
      .where(eq(cardMetaTable.backlogId, "TB-001"));
    // The plan moves as work lands, so the expected column comes from it.
    const tb001 = planned.products[1].projects[0].cards[0];
    expect(tb001.key).toBe("TB-001");
    expect(card).toMatchObject({
      status: tb001.status,
      columnSlug: tb001.status,
      number: 1,
    });

    // A person edits a seeded card; the next run must not undo or duplicate it.
    await db
      .update(schema.taskTable)
      .set({ title: "Переименовано владельцем" })
      .where(eq(schema.taskTable.projectId, tb.id));
    const second = await seedProducts(plan(), OWNER);
    expect(second.workspaces.created).toEqual([]);
    expect(second.projects.created).toEqual([]);
    expect(second.cards).toEqual({ created: 0, existing: cardCount });
    expect(
      await db.$count(
        schema.taskTable,
        and(
          eq(schema.taskTable.projectId, tb.id),
          eq(schema.taskTable.title, "Переименовано владельцем"),
        ),
      ),
    ).toBe(planned.products[1].projects[0].cards.length);
  });
});
