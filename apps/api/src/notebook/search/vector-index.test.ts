import { describe, expect, it } from "vite-plus/test";
import { encodeEmbedding } from "../embed/embedding-codec";
import { buildVectorIndex, nearestChunks } from "./vector-index";

const row = (id: string, vector: number[]) => ({
  id,
  embedding: encodeEmbedding(vector),
});

describe("vector index", () => {
  it("ranks chunks by cosine to the query", () => {
    const index = buildVectorIndex("s", [
      row("east", [1, 0]),
      row("north", [0, 5]),
      row("northeast", [3, 3]),
    ]);
    expect(index?.dims).toBe(2);
    const hits = nearestChunks(index!, new Float32Array([0.1, 1]), 2);
    expect(hits.map(({ id }) => id)).toEqual(["north", "northeast"]);
    expect(hits[0]?.score).toBeCloseTo(0.995, 3);
  });

  it("leaves out rows of another width and refuses a mismatched query", () => {
    const index = buildVectorIndex("s", [
      row("a", [1, 0]),
      row("wide", [1, 0, 0]),
      { id: "empty", embedding: null },
    ]);
    expect(index?.ids).toEqual(["a"]);
    expect(nearestChunks(index!, new Float32Array([1, 0, 0]), 5)).toEqual([]);
    expect(buildVectorIndex("s", [{ id: "x", embedding: null }])).toBeNull();
  });
});
