import { describe, expect, it } from "vite-plus/test";
import { mergeCardWorkers } from "./merge-card-workers";

const at = (hour: number) => new Date(Date.UTC(2026, 9, 29, hour));

describe("mergeCardWorkers", () => {
  it("joins the holder, the newest session and the executor per card", () => {
    const workers = mergeCardWorkers(
      [{ taskId: "a", name: "backend · s-1", kind: "agent", until: at(23) }],
      [
        {
          taskId: "a",
          name: "backend · s-1",
          kind: "agent",
          step: "тесты",
          at: at(21),
        },
        {
          taskId: "a",
          name: "qa · s-2",
          kind: "agent",
          step: "старое",
          at: at(9),
        },
        {
          taskId: null,
          name: "ops · s-3",
          kind: "agent",
          step: "без карточки",
          at: at(20),
        },
        {
          taskId: "b",
          name: "qa · s-2",
          kind: "agent",
          step: "ревью",
          at: at(8),
        },
      ],
      [
        { taskId: "a", executor: "backend" },
        { taskId: "c", executor: "ops · s-3" },
        { taskId: "d", executor: null },
      ],
    );

    expect(workers).toEqual([
      {
        taskId: "a",
        holder: { name: "backend · s-1", kind: "agent", until: at(23) },
        session: {
          name: "backend · s-1",
          kind: "agent",
          step: "тесты",
          at: at(21),
        },
        executor: "backend",
      },
      {
        taskId: "b",
        holder: null,
        session: { name: "qa · s-2", kind: "agent", step: "ревью", at: at(8) },
        executor: null,
      },
      { taskId: "c", holder: null, session: null, executor: "ops · s-3" },
    ]);
  });
});
