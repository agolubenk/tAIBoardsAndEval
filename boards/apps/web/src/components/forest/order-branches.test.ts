import { describe, expect, it } from "vite-plus/test";
import { orderBranches } from "./order-branches";

const branch = (id: string, parentId: string | null, depth: number) => ({
  id,
  parentId,
  depth,
});

describe("orderBranches", () => {
  it("puts each branch under its parent and leaves the root out", () => {
    const levels = [
      branch("root", null, 0),
      branch("a", "root", 1),
      branch("b", "root", 1),
      branch("a1", "a", 2),
      branch("b1", "b", 2),
    ];

    expect(orderBranches("root", levels).map((row) => row.id)).toEqual([
      "a",
      "a1",
      "b",
      "b1",
    ]);
  });

  it("keeps a branch whose parent is missing, at the end", () => {
    const rows = [branch("root", null, 0), branch("x1", "hidden", 2)];

    expect(orderBranches("root", rows).map((row) => row.id)).toEqual(["x1"]);
  });
});
