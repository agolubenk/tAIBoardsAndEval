import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { productsPlanSchema } from "./products-plan-schema";
import { plannedLinks } from "./seed-card-links";

const card = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  title: key,
  status: "to-do",
  priority: "low",
  ...extra,
});
const plan = (...cards: ReturnType<typeof card>[]) => ({
  version: "test",
  products: [
    {
      slug: "p",
      name: "P",
      projects: [{ key: "TB", name: "TB", icon: "Box", cards }],
    },
  ],
});
const issues = (input: unknown) => {
  const result = productsPlanSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe("productsPlanSchema", () => {
  it("accepts the committed seed plan", () => {
    const file = new URL(
      "../../../../deploy/vps/seed/products.json",
      import.meta.url,
    );
    expect(issues(JSON.parse(readFileSync(file, "utf8")))).toEqual([]);
  });

  it("rejects links outside the product, to itself and duplicate keys", () => {
    expect(
      issues(
        plan(
          card("TB-001", { blocks: ["TB-009"] }),
          card("TB-002", { related: ["TB-002"] }),
          card("TB-002"),
        ),
      ),
    ).toEqual([
      "TB-002: duplicate key",
      "TB-001: TB-009 is not a card of p",
      "TB-002: links to itself",
    ]);
  });

  it("checks a card's status against its project's process", () => {
    const bugs = (status: string) => ({
      version: "test",
      products: [
        {
          slug: "p",
          name: "P",
          projects: [
            {
              key: "PB",
              name: "Ошибки",
              icon: "Bug",
              process: "bugs",
              cards: [card("PB-001", { status })],
            },
          ],
        },
      ],
    });
    expect(issues(bugs("prod-check"))).toEqual([]);
    expect(issues(bugs("confirmation"))).toEqual([
      "PB-001: confirmation is not a column of the bugs process",
    ]);
    expect(issues(plan(card("TB-001", { status: "fixed" })))).toEqual([
      "TB-001: fixed is not a column of the tasks process",
    ]);
  });

  it("rejects a parent chain that loops", () => {
    expect(
      issues(
        plan(
          card("TB-001", { parent: "TB-003" }),
          card("TB-002", { parent: "TB-001" }),
          card("TB-003", { parent: "TB-002" }),
        ),
      ),
    ).toEqual(["TB-001: parent chain loops"]);
  });

  it("rejects fields the plan does not know", () => {
    expect(issues(plan(card("TB-001", { backlogId: "TB-001" })))).toHaveLength(
      1,
    );
  });
});

describe("plannedLinks", () => {
  it("runs a subtask parent to child and keeps blocks and related", () => {
    const parsed = productsPlanSchema.parse(
      plan(
        card("TB-001"),
        card("TB-002", {
          parent: "TB-001",
          blocks: ["TB-003"],
          related: ["TB-001"],
        }),
        card("TB-003"),
      ),
    );
    expect(plannedLinks(parsed.products[0]!)).toEqual([
      { source: "TB-001", target: "TB-002", type: "subtask" },
      { source: "TB-002", target: "TB-003", type: "blocks" },
      { source: "TB-002", target: "TB-001", type: "related" },
    ]);
  });
});
