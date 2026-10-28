import type { ImportedTask } from "@kaneo/importers";
import { describe, expect, it } from "vite-plus/test";
import {
  type NotionCardMeta,
  notionCardMeta,
  releaseTakenBacklogIds,
} from "./notion-card-meta";

function task(
  extraFields: ImportedTask["extraFields"],
  lastEditedTime = "2026-10-02T10:00:00.000Z",
): ImportedTask {
  return {
    key: "hr:notion:p-1",
    columnKey: null,
    title: "Task",
    description: "",
    priority: "no-priority",
    labelKeys: [],
    comments: [],
    sourceRef: { system: "notion", pageId: "p-1", lastEditedTime },
    ...(extraFields ? { extraFields } : {}),
  };
}

describe("notionCardMeta", () => {
  it("reads the card fields from the page's source fields", () => {
    expect(
      notionCardMeta(
        task({
          "Backlog ID": "B-12",
          "Half-baked idea": true,
          Report: "Seen on staging",
          Severity: "High",
          Type: "Ошибка",
          Status: "In progress",
          Owner: "Ana",
        }),
      ),
    ).toEqual({
      kind: "bug",
      severity: "High",
      backlogId: "B-12",
      halfBaked: true,
      report: "Seen on staging",
      notionPageId: "p-1",
      notionStatus: "In progress",
      notionEditedAt: new Date("2026-10-02T10:00:00.000Z"),
    });
  });

  it("falls back to the defaults for a page without those fields", () => {
    expect(notionCardMeta(task(undefined, "not a date"))).toMatchObject({
      kind: "task",
      severity: null,
      backlogId: null,
      halfBaked: false,
      notionEditedAt: null,
    });
  });

  it("skips tasks that did not come from Notion", () => {
    const { sourceRef: _ref, ...plain } = task({});
    expect(notionCardMeta(plain)).toBeNull();
  });
});

describe("releaseTakenBacklogIds", () => {
  const meta = (backlogId: string | null) => ({ backlogId }) as NotionCardMeta;

  it("keeps the first holder of an ID and drops repeats and taken ones", () => {
    const { rows, dropped } = releaseTakenBacklogIds(
      [
        { taskId: "a", meta: meta("B-1") },
        { taskId: "b", meta: meta("B-1") },
        { taskId: "c", meta: meta("B-2") },
        { taskId: "d", meta: meta(null) },
      ],
      new Set(["B-2"]),
    );
    expect(rows.map((row) => row.meta.backlogId)).toEqual([
      "B-1",
      null,
      null,
      null,
    ]);
    expect(dropped).toEqual(["B-1", "B-2"]);
  });
});
