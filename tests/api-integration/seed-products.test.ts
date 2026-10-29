import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import {
  cardHistoryTable,
  cardMetaTable,
} from "../../apps/api/src/database/forest-schema";
import { plannedLinks } from "../../apps/api/src/seed/seed-card-links";
import {
  type ProductsPlan,
  productsPlanSchema,
  SEED_ACTOR,
  seedProducts,
} from "../../apps/api/src/seed/seed-products";
import { resetTestDatabase } from "./helpers/database";

const PLAN = resolve(__dirname, "../../deploy/vps/seed/products.json");
const OWNER = "admin@t-boards.local";

const plan = () =>
  productsPlanSchema.parse(JSON.parse(readFileSync(PLAN, "utf8")));

const metaOf = async (backlogId: string) => {
  const [meta] = await db
    .select()
    .from(cardMetaTable)
    .where(eq(cardMetaTable.backlogId, backlogId));
  return meta;
};

const subtaskParents = async (childKey: string) => {
  const child = await metaOf(childKey);
  const rows = await db
    .select({ parent: cardMetaTable.backlogId })
    .from(schema.taskRelationTable)
    .innerJoin(
      cardMetaTable,
      eq(cardMetaTable.taskId, schema.taskRelationTable.sourceTaskId),
    )
    .where(
      and(
        eq(schema.taskRelationTable.targetTaskId, child?.taskId ?? ""),
        eq(schema.taskRelationTable.relationType, "subtask"),
      ),
    );
  return rows.map((row) => row.parent);
};

const insertOwner = () =>
  db
    .insert(schema.userTable)
    .values({ name: "admin", email: OWNER, emailVerified: true })
    .returning();

const card = (key: string, extra: object = {}) => ({
  key,
  title: key,
  status: "to-do",
  priority: "low",
  ...extra,
});
const mini = (...cards: ReturnType<typeof card>[]): ProductsPlan =>
  productsPlanSchema.parse({
    version: "test",
    products: [
      {
        slug: "mini",
        name: "Mini",
        projects: [{ key: "TB", name: "TB", icon: "Box", cards }],
      },
    ],
  });

const taskOf = async (key: string) => {
  const [task] = await db
    .select({
      id: schema.taskTable.id,
      title: schema.taskTable.title,
      description: schema.taskTable.description,
      status: schema.taskTable.status,
      priority: schema.taskTable.priority,
      columnSlug: schema.columnTable.slug,
    })
    .from(cardMetaTable)
    .innerJoin(schema.taskTable, eq(schema.taskTable.id, cardMetaTable.taskId))
    .leftJoin(
      schema.columnTable,
      eq(schema.columnTable.id, schema.taskTable.columnId),
    )
    .where(eq(cardMetaTable.backlogId, key));
  return task;
};

describe("API integration: products seed", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("refuses to seed before the admin exists", async () => {
    await expect(seedProducts(plan(), OWNER)).rejects.toThrow(/seed the admin/);
  });

  it("creates the three products with projects and cards, then only keeps them", async () => {
    const [owner] = await insertOwner();
    const planned = plan();
    const cardCount = planned.products
      .flatMap((p) => p.projects)
      .reduce((sum, p) => sum + p.cards.length, 0);
    const linkCount = planned.products.flatMap(plannedLinks).length;

    const first = await seedProducts(planned, OWNER);
    expect(first.workspaces.created).toEqual([
      "hr-helper-lavaeon",
      "aiboards-eval",
      "financial-terminal",
    ]);
    expect(first.cards.created).toBe(cardCount);
    expect(first.links.skipped).toEqual([]);
    // A pair named from both ends is one link.
    expect(first.links.created + first.links.existing).toBe(linkCount);
    expect(first.links.created).toBeGreaterThan(0);
    expect(first.sectors).toBeGreaterThan(0);
    expect(await subtaskParents("OPS-012")).toEqual(["OPS-001"]);
    expect(await subtaskParents("OPS-001")).toEqual(["OPS-100"]);
    expect(await metaOf("HRB-002")).toMatchObject({ kind: "bug" });
    expect(await metaOf("IDEA-003")).toMatchObject({ halfBaked: true });
    expect(await metaOf("ADM-001")).toMatchObject({
      executor: "Claude Opus 5.5",
      updatedBy: "seed:products",
    });

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
    ).toBe(8);

    // Each product keeps its own work, and its «Ошибки» runs the bugs process.
    const hrHelper = workspaces.find((w) => w.name === "HR Helper / Lavaeon");
    const hrProjects = await db
      .select({ id: schema.projectTable.id, slug: schema.projectTable.slug })
      .from(schema.projectTable)
      .where(eq(schema.projectTable.workspaceId, hrHelper?.id ?? ""));
    expect(hrProjects.map((p) => p.slug).sort()).toEqual(["ADM", "HRB", "HRH"]);
    const hrb = hrProjects.find((p) => p.slug === "HRB");
    const bugColumns = await db
      .select({
        slug: schema.columnTable.slug,
        isFinal: schema.columnTable.isFinal,
      })
      .from(schema.columnTable)
      .where(eq(schema.columnTable.projectId, hrb?.id ?? ""))
      .orderBy(schema.columnTable.position);
    expect(bugColumns.map((c) => c.slug)).toEqual([
      "new",
      "triage",
      "to-do",
      "in-progress",
      "in-review",
      "prod-check",
      "fixed",
      "closed",
    ]);
    expect(bugColumns.filter((c) => c.isFinal).map((c) => c.slug)).toEqual([
      "fixed",
      "closed",
    ]);
    expect((await metaOf("GL-005"))?.workspaceId).toBe(hrHelper?.id);

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
    expect(second.cards).toEqual({
      created: 0,
      existing: cardCount,
      synced: 0,
    });
    expect(second.agentFields).toEqual({ filled: 0 });
    expect(second.links).toEqual({
      created: 0,
      existing: linkCount,
      skipped: [],
    });
    expect(second.sectors).toBe(0);
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

  it("fills agent fields only where empty and keeps a parent set on the board", async () => {
    await insertOwner();
    const first = await seedProducts(
      mini(
        card("TB-001"),
        card("TB-002", { parent: "TB-001" }),
        card("TB-003", { related: ["TB-001"] }),
      ),
      OWNER,
    );
    expect(first.links).toEqual({ created: 2, existing: 0, skipped: [] });

    // On the board a person signs TB-003 and moves TB-002 under it.
    const [one, two, three] = await Promise.all(
      ["TB-001", "TB-002", "TB-003"].map(metaOf),
    );
    await db
      .update(cardMetaTable)
      .set({ executor: "человек" })
      .where(eq(cardMetaTable.taskId, three?.taskId ?? ""));
    await db
      .update(schema.taskRelationTable)
      .set({ sourceTaskId: three?.taskId ?? "" })
      .where(
        and(
          eq(schema.taskRelationTable.sourceTaskId, one?.taskId ?? ""),
          eq(schema.taskRelationTable.targetTaskId, two?.taskId ?? ""),
        ),
      );

    const second = await seedProducts(
      mini(
        card("TB-001", { branch: "feature/x" }),
        card("TB-002", { parent: "TB-001" }),
        card("TB-003", {
          related: ["TB-001"],
          executor: "агент",
          files: ["a.ts"],
        }),
      ),
      OWNER,
    );
    expect(second.agentFields).toEqual({ filled: 2 });
    expect(await metaOf("TB-001")).toMatchObject({ branch: "feature/x" });
    expect(await metaOf("TB-003")).toMatchObject({
      executor: "человек",
      files: ["a.ts"],
    });
    expect(second.links).toEqual({
      created: 0,
      existing: 1,
      skipped: ["TB-001 subtask TB-002: card has another parent"],
    });
    expect(await subtaskParents("TB-002")).toEqual(["TB-003"]);
  });

  it("brings a four-column board to the process and keeps a column people added", async () => {
    await insertOwner();
    await seedProducts(
      mini(card("TB-001"), card("TB-002", { status: "in-progress" })),
      OWNER,
    );
    // The board as Kaneo made it before the process, plus a person's column.
    const [project] = await db
      .select({ id: schema.projectTable.id })
      .from(schema.projectTable)
      .where(eq(schema.projectTable.slug, "TB"));
    const projectId = project?.id ?? "";
    const columns = () =>
      db
        .select({ slug: schema.columnTable.slug })
        .from(schema.columnTable)
        .where(eq(schema.columnTable.projectId, projectId))
        .orderBy(schema.columnTable.position)
        .then((rows) => rows.map((row) => row.slug));
    await db
      .delete(schema.columnTable)
      .where(
        and(
          eq(schema.columnTable.projectId, projectId),
          inArray(schema.columnTable.slug, [
            "new",
            "grilling",
            "confirmation",
            "closed",
          ]),
        ),
      );
    await db.insert(schema.columnTable).values({
      projectId,
      name: "Blocked",
      slug: "blocked",
      position: 1,
    });

    const second = await seedProducts(
      mini(
        card("TB-001", { status: "new" }),
        card("TB-002", { status: "in-progress" }),
      ),
      OWNER,
    );
    expect(second.columns).toEqual({ added: 4 });
    expect(await columns()).toEqual([
      "new",
      "grilling",
      "to-do",
      "in-progress",
      "in-review",
      "confirmation",
      "done",
      "closed",
      "blocked",
    ]);
    // The plan reaches a column the same run added.
    expect(await taskOf("TB-001")).toMatchObject({
      status: "new",
      columnSlug: "new",
    });
    expect(await taskOf("TB-002")).toMatchObject({ columnSlug: "in-progress" });

    // A complete board keeps the order its people gave it.
    await db
      .update(schema.columnTable)
      .set({ position: -1 })
      .where(
        and(
          eq(schema.columnTable.projectId, projectId),
          eq(schema.columnTable.slug, "blocked"),
        ),
      );
    const third = await seedProducts(
      mini(
        card("TB-001", { status: "new" }),
        card("TB-002", { status: "in-progress" }),
      ),
      OWNER,
    );
    expect(third.columns).toEqual({ added: 0 });
    expect((await columns())[0]).toBe("blocked");
  });

  it("moves an untouched seeded card to the plan and leaves an edited one", async () => {
    await insertOwner();
    await seedProducts(
      mini(
        card("TB-001", { description: "Начало." }),
        card("TB-002"),
        card("TB-003"),
      ),
      OWNER,
    );
    // A person drags TB-002 to in-progress: kaneo's route leaves no actor.
    const two = await taskOf("TB-002");
    await db
      .update(schema.taskTable)
      .set({ status: "in-progress" })
      .where(eq(schema.taskTable.id, two?.id ?? ""));

    const next = mini(
      card("TB-001", {
        description: "Начало.\n\nСессии: 2c",
        status: "done",
        priority: "high",
      }),
      card("TB-002", { status: "done" }),
      card("TB-003"),
    );
    const second = await seedProducts(next, OWNER);
    expect(second.cards).toEqual({ created: 0, existing: 3, synced: 1 });
    expect(await taskOf("TB-001")).toMatchObject({
      description: "Начало.\n\nСессии: 2c",
      status: "done",
      columnSlug: "done",
      priority: "high",
    });
    expect(await taskOf("TB-002")).toMatchObject({ status: "in-progress" });

    // The sync is in the card's history under the seed, so it can be undone,
    // and a later plan still reaches the card.
    const one = await taskOf("TB-001");
    const history = await db
      .select({ actorId: cardHistoryTable.actorId })
      .from(cardHistoryTable)
      .where(
        and(
          eq(cardHistoryTable.taskId, one?.id ?? ""),
          eq(cardHistoryTable.kind, "task"),
        ),
      );
    expect(history).toEqual([{ actorId: SEED_ACTOR }]);
    const third = await seedProducts(
      mini(
        card("TB-001", { status: "in-review", priority: "high" }),
        card("TB-002", { status: "done" }),
        card("TB-003"),
      ),
      OWNER,
    );
    expect(third.cards.synced).toBe(1);
    expect(await taskOf("TB-001")).toMatchObject({
      status: "in-review",
      description: "",
    });
  });
});
