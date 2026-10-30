import { describe, expect, it } from "vite-plus/test";
import { fitNodeBudget } from "./fit-node-budget";

describe("fitNodeBudget", () => {
  const card = (files: string[], decisions: string[] = []) => ({
    files,
    decisions,
  });

  it("counts a shared file once and stops before the budget", () => {
    const cards = [card(["a", "b"]), card(["a"], ["D-001"]), card(["c", "d"])];
    // 1 + 2, then 1 + 1 (a is carried) = 5, the third would make 8.
    expect(fitNodeBudget(cards, 7)).toHaveLength(2);
    expect(fitNodeBudget(cards, 8)).toHaveLength(3);
  });

  it("always takes the first card", () => {
    expect(fitNodeBudget([card(["a", "b", "c"])], 2)).toHaveLength(1);
    expect(fitNodeBudget([], 10)).toEqual([]);
  });
});
