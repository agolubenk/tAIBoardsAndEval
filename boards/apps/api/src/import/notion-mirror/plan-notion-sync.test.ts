import type { ImportedTask } from "@kaneo/importers";
import { describe, expect, it } from "vite-plus/test";
import {
  type MirroredCard,
  numberFreshTasks,
  planNotionSync,
} from "./plan-notion-sync";

function task(pageId: string, lastEditedTime: string): ImportedTask {
  return {
    key: `hr:notion:${pageId}`,
    columnKey: null,
    title: pageId,
    description: "",
    priority: "no-priority",
    labelKeys: [],
    comments: [],
    sourceRef: { system: "notion", pageId, lastEditedTime },
  };
}

function card(
  pageId: string,
  projectId: string,
  editedAt: string | null,
): MirroredCard {
  return {
    taskId: `task-${pageId}`,
    projectId,
    notionPageId: pageId,
    notionEditedAt: editedAt ? new Date(editedAt) : null,
  };
}

const T1 = "2026-10-01T10:00:00.000Z";
const T2 = "2026-10-02T10:00:00.000Z";

describe("planNotionSync", () => {
  it("creates unknown pages, rewrites edited ones and skips the rest", () => {
    const plan = planNotionSync(
      [task("a", T2), task("b", T1), task("c", T1), task("d", T1)],
      [card("a", "p1", T1), card("b", "p1", T1), card("c", "p2", null)],
    );

    expect(plan.projectId).toBe("p1");
    expect(plan.fresh.map((fresh) => fresh.sourceRef?.pageId)).toEqual(["d"]);
    expect(plan.changed.map(({ taskId }) => taskId)).toEqual([
      "task-a",
      "task-c",
    ]);
    expect(plan.unchanged).toBe(1);
  });

  it("has no project before the first import", () => {
    const plan = planNotionSync([task("a", T1)], []);
    expect(plan).toEqual({
      projectId: null,
      fresh: [task("a", T1)],
      changed: [],
      unchanged: 0,
      mirrored: new Map(),
    });
  });
});

describe("numberFreshTasks", () => {
  it("keeps free source numbers and continues after the project's last", () => {
    expect(numberFreshTasks([7, 3, undefined, 7, 0], new Set([3]), 5)).toEqual({
      numbers: [7, 8, 9, 10, 11],
      lastNumber: 11,
    });
  });

  it("starts after the last number when nothing is kept", () => {
    expect(numberFreshTasks([undefined], new Set(), 12)).toEqual({
      numbers: [13],
      lastNumber: 13,
    });
  });
});
