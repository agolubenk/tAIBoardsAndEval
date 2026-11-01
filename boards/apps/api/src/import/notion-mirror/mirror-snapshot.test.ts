import type { ImportedProject, NotionPage } from "@kaneo/importers";
import { describe, expect, it } from "vite-plus/test";
import { snapshotTasks } from "./mirror-snapshot";

const PROJECT: ImportedProject = {
  name: "Tasks",
  columns: [
    { key: "status:open", name: "Open", isFinal: false },
    { key: "status:done", name: "Done", isFinal: true },
  ],
  labels: [],
  tasks: [
    {
      key: "notion:p-archived",
      columnKey: "status:done",
      title: "Old",
      description: "",
      priority: "no-priority",
      labelKeys: [],
      comments: [],
      sourceRef: { system: "notion", pageId: "p-archived", lastEditedTime: "" },
    },
  ],
  relations: [],
  warnings: [],
};

function page(id: string, type?: string): NotionPage {
  return {
    object: "page",
    id,
    archived: false,
    created_time: "2026-10-01T09:00:00.000Z",
    last_edited_time: "2026-10-01T09:00:00.000Z",
    properties: type
      ? { Type: { id: "y", type: "select", select: { name: type } } }
      : {},
  };
}

describe("snapshotTasks", () => {
  it("recovers column keys from slugs and keeps unknown columns visible", () => {
    const tasks = snapshotTasks(
      [
        {
          taskId: "t1",
          title: "A",
          status: "open",
          columnSlug: "open",
          notionPageId: "p1",
        },
        {
          taskId: "t2",
          title: "B",
          status: "review",
          columnSlug: "review",
          notionPageId: "p2",
        },
      ],
      PROJECT,
      [page("p1", "Bug"), page("p2")],
    );
    expect(tasks.map(({ columnKey }) => columnKey)).toEqual([
      "status:open",
      "kaneo:review",
    ]);
    expect(tasks[0]?.extraFields).toEqual({ Type: "Bug" });
    expect(tasks[1]?.extraFields).toEqual({});
  });

  it("gives an archived card the status Notion expects", () => {
    const [task] = snapshotTasks(
      [
        {
          taskId: "t3",
          title: "Old",
          status: "archived",
          columnSlug: null,
          notionPageId: "p-archived",
        },
      ],
      PROJECT,
      [],
    );
    expect(task).toMatchObject({
      key: "notion:p-archived",
      archived: true,
      columnKey: "status:done",
    });
  });
});
