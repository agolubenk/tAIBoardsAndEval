import { describe, expect, it } from "vite-plus/test";
import { buildLog } from "./build-log";
import { buildSeeds } from "./build-seeds";
import type { FelledTask, TreeMaterial } from "./tree-material";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 27, 10, minute));

function task(id: string, number: number, title: string): FelledTask {
  return {
    id,
    projectId: "p1",
    number,
    title,
    description: `${title} description`,
    status: "in-progress",
    priority: "medium",
    userId: null,
    columnId: null,
    startDate: null,
    dueDate: null,
    createdAt: at(number),
    updatedAt: at(number),
    revision: 1,
  };
}

function material(overrides: Partial<TreeMaterial> = {}): TreeMaterial {
  const root = task("root", 1, "Root");
  const a = task("a", 2, "Branch A");
  const a1 = task("a1", 3, "Twig A1");
  const b = task("b", 4, "Branch B");
  return {
    root,
    projectName: "Forest",
    tasks: [root, a, a1, b],
    edges: [
      { parentId: "root", childId: "b" },
      { parentId: "root", childId: "a" },
      { parentId: "a", childId: "a1" },
    ],
    activities: [
      {
        taskId: "root",
        type: "comment",
        content: "root decision",
        userId: "u1",
        createdAt: at(5),
        eventData: null,
      },
      {
        taskId: "a1",
        type: "comment",
        content: "twig note",
        userId: "u1",
        createdAt: at(6),
        eventData: null,
      },
    ],
    labels: [{ taskId: "root", name: "backend" }],
    assets: [],
    outerLinks: [],
    ...overrides,
  };
}

describe("buildLog", () => {
  it("keeps the root's fields and history and lists every felled task", () => {
    const log = buildLog(material());
    expect(log.sourceTaskId).toBe("root");
    expect(log.finalStatus).toBe("in-progress");
    expect(log.fields).toMatchObject({ labels: ["backend"], branchCount: 3 });
    expect(log.history).toEqual([
      expect.objectContaining({ type: "comment", content: "root decision" }),
    ]);
    expect(log.felledTaskIds).toEqual(["root", "a", "a1", "b"]);
    expect(log.searchText).toContain("root decision");
  });
});

describe("buildSeeds", () => {
  it("makes one seed per first-level branch, in board order", () => {
    const seeds = buildSeeds(material());
    expect(seeds.map((s) => s.title)).toEqual(["Branch A", "Branch B"]);
    expect(seeds[0]?.sourceTaskIds).toEqual(["a", "a1"]);
    expect(seeds[0]?.body).toContain("- Twig A1 — in-progress");
    expect(seeds[0]?.body).toContain("twig note");
    expect(seeds[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("adds a links seed for links that leave the tree", () => {
    const seeds = buildSeeds(
      material({
        outerLinks: [
          {
            felledTaskId: "a1",
            otherTaskId: "x9",
            otherTitle: "Other tree",
            relationType: "blocks",
            direction: "out",
          },
        ],
      }),
    );
    const links = seeds.find((s) => s.kind === "links");
    expect(links?.body).toContain("- Twig A1 —blocks→ Other tree (x9)");
    expect(links?.sourceTaskIds).toEqual(["a1"]);
  });

  it("survives a subtask cycle and caps the body", () => {
    const seeds = buildSeeds(
      material({
        edges: [
          { parentId: "root", childId: "a" },
          { parentId: "a", childId: "a1" },
          { parentId: "a1", childId: "a" },
        ],
      }),
      { maxBodyChars: 120 },
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.body.length).toBeLessThanOrEqual(120);
    expect(seeds[0]?.body).toContain("branches are not restored");
  });

  it("runs every seed through the sanitizer", () => {
    const seeds = buildSeeds(material(), {
      sanitize: (text) => text.replaceAll("twig note", "[REDACTED:test]"),
    });
    expect(seeds[0]?.body).toContain("[REDACTED:test]");
    expect(seeds[0]?.body).not.toContain("twig note");
  });
});
