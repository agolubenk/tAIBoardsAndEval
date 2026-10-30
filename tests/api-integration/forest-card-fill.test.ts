import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest } from "./helpers/forest";

type Forest = Awaited<ReturnType<typeof createForest>>;

// The agent of one session, with its own key (R-010).
async function sessionAgent(forest: Forest) {
  const issued = await forest.agentApi("POST", "/agent-identity/session", {
    harness: "claude-code",
    session: "bb",
  });
  expect(issued.status).toBe(200);
  const key = String(issued.body.key);
  const agentId = String(issued.body.agent.id);
  const as = (headers: Record<string, string> = {}) => ({
    "x-api-key": key,
    ...headers,
  });
  return { agentId, as };
}

async function takeLease(
  forest: Forest,
  as: (headers?: Record<string, string>) => Record<string, string>,
  taskId: string,
) {
  const res = await forest.agentApi(
    "POST",
    `/forest/${forest.workspace.id}/leases`,
    { taskId },
    as(),
  );
  expect(res.status).toBe(200);
  return String(res.body.fencingToken);
}

async function taskRow(id: string) {
  const [row] = await db
    .select()
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, id));
  return row;
}

async function comments(taskId: string) {
  return db
    .select({
      userId: schema.activityTable.userId,
      content: schema.activityTable.content,
    })
    .from(schema.activityTable)
    .where(
      and(
        eq(schema.activityTable.taskId, taskId),
        eq(schema.activityTable.type, "comment"),
      ),
    );
}

async function links(taskId: string) {
  return db
    .select({ url: schema.externalLinkTable.url })
    .from(schema.externalLinkTable)
    .where(eq(schema.externalLinkTable.taskId, taskId));
}

describe("card fill on an agent's move (owner, 30.10)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("takes the card, dates the start and tells the owner with the note", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Task");
    const { agentId, as } = await sessionAgent(forest);
    const fence = await takeLease(forest, as, task.id);

    const note = "Начал: схема и тест «кириллица»";
    const moved = await forest.agentApi(
      "PUT",
      `/task/status/${task.id}`,
      { status: "in-progress" },
      as({
        "x-t-boards-fence": fence,
        "x-t-boards-note": encodeURIComponent(note),
      }),
    );
    expect(moved.status).toBe(200);

    const row = await taskRow(task.id);
    expect(row?.userId).toBe(agentId);
    expect(row?.startDate).toBeInstanceOf(Date);

    const [comment] = await comments(task.id);
    expect(comment?.userId).toBe(agentId);
    expect(comment?.content).toContain(`<kaneo-mention id="${forest.ownerId}"`);
    expect(comment?.content).toContain("→");
    expect(comment?.content).toContain(note);
  });

  it("keeps an assignee and start date someone already set", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Task");
    const start = new Date("2026-10-01T09:00:00Z");
    await db
      .update(schema.taskTable)
      .set({ userId: forest.ownerId, startDate: start })
      .where(eq(schema.taskTable.id, task.id));
    const { as } = await sessionAgent(forest);
    const fence = await takeLease(forest, as, task.id);

    const moved = await forest.agentApi(
      "PUT",
      `/task/status/${task.id}`,
      { status: "in-progress" },
      as({ "x-t-boards-fence": fence }),
    );
    expect(moved.status).toBe(200);
    const row = await taskRow(task.id);
    expect(row?.userId).toBe(forest.ownerId);
    expect(row?.startDate?.toISOString()).toBe(start.toISOString());
  });

  it("refuses review without a link and takes it with one", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Task");
    const { as } = await sessionAgent(forest);
    const fence = await takeLease(forest, as, task.id);
    const review = (headers: Record<string, string> = {}) =>
      forest.agentApi(
        "PUT",
        `/task/status/${task.id}`,
        { status: "in-review" },
        as({ "x-t-boards-fence": fence, ...headers }),
      );

    const bare = await review();
    expect(bare.status).toBe(400);
    expect(bare.body.message).toContain("card_incomplete");
    expect((await taskRow(task.id))?.status).toBe("to-do");

    const pr = "https://github.com/agolubenk/t-boards/pull/7";
    const ok = await review({ "x-t-boards-link": pr });
    expect(ok.status).toBe(200);
    expect((await taskRow(task.id))?.status).toBe("in-review");
    expect((await links(task.id)).map((l) => l.url)).toEqual([pr]);
    const [comment] = await comments(task.id);
    expect(comment?.content).toContain(pr);

    // Back and forth again: the link already on the card is enough.
    await forest.agentApi(
      "PUT",
      `/task/status/${task.id}`,
      { status: "in-progress" },
      as({ "x-t-boards-fence": fence }),
    );
    const again = await review({ "x-t-boards-link": pr });
    expect(again.status).toBe(200);
    expect(await links(task.id)).toHaveLength(1);
    expect((await review()).status).toBe(200);
  });

  it("ignores a note it cannot decode and a link that is not http", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Task");
    const { as } = await sessionAgent(forest);
    const fence = await takeLease(forest, as, task.id);

    const moved = await forest.agentApi(
      "PUT",
      `/task/status/${task.id}`,
      { status: "in-review" },
      as({
        "x-t-boards-fence": fence,
        "x-t-boards-note": "%E0%A4%A",
        "x-t-boards-link": "javascript:alert(1)",
      }),
    );
    expect(moved.status).toBe(400);
    expect(moved.body.message).toContain("card_incomplete");
    expect(await links(task.id)).toHaveLength(0);
  });
});
