import { describe, expect, it } from "vite-plus/test";
import { classifyTaskRequest, readsBody } from "./classify-task-request";

const classify = (method: string, path: string, body = {}) =>
  classifyTaskRequest(method, path.split("/").filter(Boolean), body);

describe("classifyTaskRequest", () => {
  it("passes reads, drafts and duplicates", () => {
    expect(classify("GET", "t1").kind).toBe("pass");
    expect(classify("GET", "tasks/p1").kind).toBe("pass");
    expect(classify("POST", "draft-upload/p1/finalize").kind).toBe("pass");
    expect(classify("POST", "duplicate/t1").kind).toBe("pass");
  });

  it("forbids deleting, bulk, reorder and import", () => {
    expect(classify("DELETE", "t1")).toMatchObject({
      kind: "forbidden",
      action: "task.delete",
      targetId: "t1",
    });
    expect(classify("PATCH", "bulk").kind).toBe("forbidden");
    expect(classify("POST", "reorder").kind).toBe("forbidden");
    expect(classify("POST", "import/p1").kind).toBe("forbidden");
  });

  it("fails closed on a write it does not know", () => {
    expect(classify("PUT", "archive/t1")).toMatchObject({
      kind: "forbidden",
      action: "task.put",
    });
    expect(classify("DELETE", "t1/labels").kind).toBe("forbidden");
  });

  it("reads a create with its status", () => {
    expect(classify("POST", "p1", { status: "done", title: "x" })).toEqual({
      kind: "create",
      projectId: "p1",
      status: "done",
    });
  });

  it("reads what a full update changes", () => {
    expect(
      classify("PUT", "t1", {
        title: "T",
        description: "",
        status: "done",
        priority: "high",
        projectId: "p1",
        position: 1,
      }),
    ).toEqual({
      kind: "edit",
      action: "task.update",
      taskId: "t1",
      changes: {
        title: "T",
        description: "",
        status: "done",
        priority: "high",
        projectId: "p1",
      },
    });
  });

  it("reads single-field routes", () => {
    expect(classify("PUT", "status/t1", { status: "in-review" })).toEqual({
      kind: "edit",
      action: "task.status",
      taskId: "t1",
      changes: { status: "in-review" },
    });
    expect(
      classify("PUT", "move/t1", {
        destinationProjectId: "p2",
        destinationStatus: "done",
      }),
    ).toMatchObject({ changes: { projectId: "p2", status: "done" } });
    expect(classify("PUT", "description/t1", { description: null })).toEqual(
      expect.objectContaining({ changes: { description: null } }),
    );
    expect(classify("PUT", "assignee/t1", { userId: "u" })).toMatchObject({
      kind: "edit",
      changes: {},
    });
    expect(classify("POST", "image-upload/t1/finalize")).toMatchObject({
      kind: "edit",
      taskId: "t1",
    });
  });
});

describe("readsBody", () => {
  it("reads JSON bodies of creates and edits only", () => {
    expect(readsBody("PUT", ["status", "t1"])).toBe(true);
    expect(readsBody("POST", ["p1"])).toBe(true);
    expect(readsBody("PUT", ["image-upload", "t1"])).toBe(false);
    expect(readsBody("POST", ["reorder"])).toBe(false);
    expect(readsBody("DELETE", ["t1"])).toBe(false);
  });
});
