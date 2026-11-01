import { describe, expect, it } from "vite-plus/test";
import { decideRollback } from "./decide-rollback";

const edit = {
  title: { from: "Plant", to: "Plant (agent)" },
  priority: { from: "low", to: "high" },
};

describe("decideRollback (R-023)", () => {
  it("restores every field the edit changed", () => {
    const decision = decideRollback(edit, {
      title: "Plant (agent)",
      priority: "high",
      status: "to-do",
    });

    expect(decision).toEqual({
      ok: true,
      restore: { title: "Plant", priority: "low" },
    });
  });

  it("refuses when a later edit changed one of the fields", () => {
    const decision = decideRollback(edit, {
      title: "Plant (owner)",
      priority: "high",
    });

    expect(decision).toEqual({
      ok: false,
      reason: "changed again since: title; roll back the later edit first",
    });
  });

  it("compares lists and nulls by value", () => {
    const decision = decideRollback(
      {
        files: { from: [], to: ["a.ts"] },
        report: { from: "draft", to: null },
      },
      { files: ["a.ts"], report: null },
    );

    expect(decision).toEqual({
      ok: true,
      restore: { files: [], report: "draft" },
    });
  });

  it("refuses a field this path cannot restore", () => {
    const decision = decideRollback(
      { projectId: { from: "p1", to: "p2" }, title: edit.title },
      { projectId: "p2", title: "Plant (agent)" },
      { projectId: "move the card back first" },
    );

    expect(decision).toEqual({
      ok: false,
      reason: "projectId: move the card back first",
    });
  });
});
