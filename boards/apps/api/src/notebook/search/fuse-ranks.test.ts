import { describe, expect, it } from "vite-plus/test";
import { fuseRanks } from "./fuse-ranks";

describe("fuseRanks", () => {
  it("puts a hit both lists share above a lone first place", () => {
    const fused = fuseRanks([
      { by: "vector", ids: ["a", "b", "c"] },
      { by: "keyword", ids: ["d", "b", "c"] },
    ]);
    expect(fused.map(({ id }) => id)).toEqual(["b", "c", "a", "d"]);
    expect(fused[0]?.matchedBy).toEqual(["vector", "keyword"]);
    expect(fused[2]?.matchedBy).toEqual(["vector"]);
  });

  it("keeps a single list in its own order", () => {
    const fused = fuseRanks([
      { by: "keyword", ids: ["x", "y"] },
      { by: "vector", ids: [] },
    ]);
    expect(fused.map(({ id }) => id)).toEqual(["x", "y"]);
    expect(fused[0]?.score).toBeCloseTo(1 / 61);
  });
});
