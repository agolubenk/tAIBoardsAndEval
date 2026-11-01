import { describe, expect, it } from "vite-plus/test";
import type {
  NotionDatabase,
  NotionPage,
  NotionPropertyValue,
} from "./api-types.js";
import {
  mapColumns,
  mapDatabase,
  mapPage,
  mapPriorityName,
} from "./mapping.js";

const STATUS_SCHEMA = {
  id: "st",
  name: "Status",
  type: "status",
  status: {
    options: [
      { id: "o1", name: "Backlog" },
      { id: "o2", name: "In progress" },
      { id: "o3", name: "Done" },
      { id: "o4", name: "Won't do" },
    ],
    groups: [
      { name: "To-do", option_ids: ["o1"] },
      { name: "In progress", option_ids: ["o2"] },
      { name: "Complete", option_ids: ["o3", "o4"] },
    ],
  },
};

function database(overrides: Partial<NotionDatabase> = {}): NotionDatabase {
  return {
    id: "db-1",
    title: [{ plain_text: "Tasks" }],
    properties: {
      Status: STATUS_SCHEMA,
      Name: { id: "t", name: "Name", type: "title" },
    },
    ...overrides,
  };
}

function prop(
  type: string,
  value: Omit<NotionPropertyValue, "id" | "type">,
): NotionPropertyValue {
  return { id: type, type, ...value };
}

function page(
  id: string,
  properties: Record<string, NotionPropertyValue> = {},
  overrides: Partial<NotionPage> = {},
): NotionPage {
  return {
    object: "page",
    id,
    archived: false,
    created_time: "2026-10-01T09:00:00.000Z",
    last_edited_time: "2026-10-02T10:00:00.000Z",
    properties: {
      Name: prop("title", { title: [{ plain_text: `Task ${id}` }] }),
      ...properties,
    },
    ...overrides,
  };
}

const status = (name: string) => prop("status", { status: { name } });
const select = (name: string) => prop("select", { select: { name } });

const CONTEXT = {
  product: "hr",
  columnKeyByStatus: mapColumns(database()).columnKeyByStatus,
  description: "",
};

describe("mapColumns", () => {
  it("keeps the status order and marks the Complete group final", () => {
    expect(mapColumns(database()).columns).toEqual([
      { key: "backlog", name: "Backlog", isFinal: false },
      { key: "in-progress", name: "In progress", isFinal: false },
      { key: "done", name: "Done", isFinal: true },
      { key: "won-t-do", name: "Won't do", isFinal: true },
    ]);
  });

  it("falls back to final-looking names when a select has no groups", () => {
    const columns = mapColumns(
      database({
        properties: {
          Status: {
            id: "st",
            name: "Status",
            type: "select",
            select: { options: [{ name: "Новая" }, { name: "Готово" }] },
          },
        },
      }),
    ).columns;
    expect(columns.map((column) => column.isFinal)).toEqual([false, true]);
  });
});

describe("mapPriorityName", () => {
  it("reads names and P-levels, and leaves the rest without priority", () => {
    expect(mapPriorityName("P0")).toBe("urgent");
    expect(mapPriorityName("Высокий")).toBe("high");
    expect(mapPriorityName("p2")).toBe("medium");
    expect(mapPriorityName("Low")).toBe("low");
    expect(mapPriorityName("Someday")).toBe("no-priority");
    expect(mapPriorityName(undefined)).toBe("no-priority");
  });
});

describe("mapPage", () => {
  it("maps status, priority, number, due date, labels and the source reference", () => {
    const { task, labels } = mapPage(
      page("p-1", {
        Status: status("In progress"),
        Priority: select("P1"),
        ID: prop("unique_id", { unique_id: { prefix: "T", number: 42 } }),
        Due: prop("date", { date: { start: "2026-11-05" } }),
        Tags: prop("multi_select", {
          multi_select: [{ id: "l1", name: "backend", color: "blue" }],
        }),
      }),
      CONTEXT,
    );

    expect(task).toMatchObject({
      key: "hr:notion:p-1",
      number: 42,
      columnKey: "in-progress",
      title: "Task p-1",
      priority: "high",
      dueDate: "2026-11-05T00:00:00.000Z",
      labelKeys: ["l1"],
      sourceRef: {
        system: "notion",
        pageId: "p-1",
        lastEditedTime: "2026-10-02T10:00:00.000Z",
      },
    });
    expect(task.archived).toBeUndefined();
    expect(labels).toEqual([{ key: "l1", name: "backend", color: "#3b82f6" }]);
  });

  it("uses severity when there is no priority", () => {
    const { task } = mapPage(
      page("p-2", { Severity: select("Critical") }),
      CONTEXT,
    );
    expect(task.priority).toBe("urgent");
  });

  it("archives trashed and archived pages with the reason", () => {
    const trashed = mapPage(page("p-3", {}, { in_trash: true }), CONTEXT).task;
    const archived = mapPage(page("p-4", {}, { archived: true }), CONTEXT).task;
    expect(trashed).toMatchObject({
      archived: true,
      terminalReason: "Page is in the Notion trash",
    });
    expect(archived).toMatchObject({
      archived: true,
      terminalReason: "Page is archived in Notion",
    });
  });

  it("keeps source fields verbatim, people by name only", () => {
    const { task } = mapPage(
      page("p-5", {
        "Backlog ID": prop("unique_id", {
          unique_id: { prefix: "B", number: 12 },
        }),
        "Half-baked idea": prop("checkbox", { checkbox: true }),
        Report: prop("rich_text", {
          rich_text: [{ plain_text: " Seen on staging " }],
        }),
        Type: select("Bug"),
        Reviewer: prop("people", {
          people: [
            { name: "Ana Example", person: { email: "ana@example.test" } },
          ],
        }),
      }),
      CONTEXT,
    );

    expect(task.extraFields).toEqual({
      "Backlog ID": "B-12",
      "Half-baked idea": true,
      Report: "Seen on staging",
      Type: "Bug",
      Reviewer: "Ana Example",
    });
    expect(JSON.stringify(task.extraFields)).not.toContain("@");
  });

  it("leaves a page without a known status out of every column", () => {
    const { task } = mapPage(page("p-6", { Status: status("Gone") }), CONTEXT);
    expect(task.columnKey).toBeNull();
  });
});

describe("mapDatabase", () => {
  it("stores an edge listed from both ends once", () => {
    const parent = page("parent", {
      "Sub-items": prop("relation", { relation: [{ id: "child" }] }),
      "Related to": prop("relation", { relation: [{ id: "other" }] }),
    });
    const child = page("child", {
      "Parent item": prop("relation", { relation: [{ id: "parent" }] }),
    });
    const other = page("other", {
      "Related to": prop("relation", { relation: [{ id: "parent" }] }),
    });

    const project = mapDatabase(
      database(),
      [parent, child, other],
      new Map(),
      "hr",
    );

    expect(project.relations).toEqual([
      {
        sourceKey: "hr:notion:parent",
        targetKey: "hr:notion:child",
        type: "subtask",
      },
      {
        sourceKey: "hr:notion:parent",
        targetKey: "hr:notion:other",
        type: "related",
      },
    ]);
  });

  it("takes page bodies and warns when the database has no status", () => {
    const project = mapDatabase(
      database({ properties: {} }),
      [page("p-7")],
      new Map([["p-7", "Body text"]]),
      "hr",
    );
    expect(project.name).toBe("Tasks");
    expect(project.columns).toEqual([]);
    expect(project.tasks[0]?.description).toBe("Body text");
    expect(project.warnings).toHaveLength(1);
  });
});
