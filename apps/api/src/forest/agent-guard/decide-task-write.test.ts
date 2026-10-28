import { describe, expect, it } from "vite-plus/test";
import { decideTaskWrite } from "./decide-task-write";

const current = {
  title: "Owner task",
  description: "Do X",
  status: "to-do",
  priority: "low",
};
const open = { closes: false, authoredByAgent: false };

describe("decideTaskWrite", () => {
  it("lets an agent move open statuses and touch nothing else", () => {
    expect(decideTaskWrite({ status: "in-progress" }, current, open)).toEqual({
      kind: "allow",
      approval: null,
    });
    expect(decideTaskWrite({}, current, open)).toEqual({
      kind: "allow",
      approval: null,
    });
  });

  it("refuses edits of the owner's title or description", () => {
    expect(decideTaskWrite({ title: "Mine now" }, current, open).kind).toBe(
      "deny",
    );
    expect(decideTaskWrite({ description: "" }, current, open).kind).toBe(
      "deny",
    );
  });

  it("treats a resent unchanged text as no edit", () => {
    expect(
      decideTaskWrite(
        { title: "Owner task", description: "Do X", status: "to-do" },
        current,
        open,
      ),
    ).toEqual({ kind: "allow", approval: null });
    expect(
      decideTaskWrite(
        { description: "" },
        { ...current, description: null },
        open,
      ).kind,
    ).toBe("allow");
  });

  it("lets an agent edit the text of a card an agent created", () => {
    expect(
      decideTaskWrite({ title: "Better" }, current, {
        ...open,
        authoredByAgent: true,
      }).kind,
    ).toBe("allow");
  });

  it("asks for the owner's «да» to close or reprioritise", () => {
    expect(
      decideTaskWrite({ status: "done" }, current, { ...open, closes: true }),
    ).toEqual({
      kind: "allow",
      approval: { action: "close_task", value: "done" },
    });
    expect(decideTaskWrite({ priority: "urgent" }, current, open)).toEqual({
      kind: "allow",
      approval: { action: "set_priority", value: "urgent" },
    });
  });

  it("does not ask again for a status the card already has", () => {
    expect(
      decideTaskWrite(
        { status: "done" },
        { ...current, status: "done" },
        { ...open, closes: true },
      ),
    ).toEqual({ kind: "allow", approval: null });
  });

  it("refuses closing and reprioritising in one request", () => {
    expect(
      decideTaskWrite({ status: "done", priority: "high" }, current, {
        ...open,
        closes: true,
      }).kind,
    ).toBe("deny");
  });
});
