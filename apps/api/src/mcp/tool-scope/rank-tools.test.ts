import { describe, expect, it } from "vite-plus/test";
import { rankTools } from "./rank-tools";

const docs = [
  { name: "create_time_entry", description: "Log time spent on a task." },
  {
    name: "list_task_time_entries",
    description: "List time logged on a task.",
  },
  { name: "delete_label", description: "Delete a workspace label." },
  { name: "attach_label_to_task", description: "Attach a label to a task." },
  { name: "list_notifications", description: "List the user's notifications." },
];

describe("rankTools", () => {
  it("puts the tools nearest to the request first", () => {
    expect(rankTools("log a time entry", docs, 5).slice(0, 2)).toEqual([
      "create_time_entry",
      "list_task_time_entries",
    ]);
  });

  it("returns no more than the limit", () => {
    expect(rankTools("task label time", docs, 2)).toHaveLength(2);
  });

  it("drops a tool that shares only a passing word with the request", () => {
    const withFeed = [
      ...docs,
      {
        name: "list_feed",
        description: "List the activity feed, entry by entry.",
      },
    ];

    expect(rankTools("time entry", withFeed, 5)).not.toContain("list_feed");
  });

  it("returns nothing when no word of the request is known", () => {
    expect(rankTools("deploy the server", docs, 5)).toEqual([]);
  });

  it("folds plurals, so labels finds label tools", () => {
    expect([...rankTools("labels", docs, 5)].sort()).toEqual([
      "attach_label_to_task",
      "delete_label",
    ]);
  });
});
