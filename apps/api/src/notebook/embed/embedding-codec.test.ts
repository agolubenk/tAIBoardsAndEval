import { describe, expect, it } from "vite-plus/test";
import {
  decodeEmbedding,
  dot,
  encodeEmbedding,
  normalize,
  parseEmbedding,
} from "./embedding-codec";

describe("embedding codec", () => {
  it("round-trips float32 through base64", () => {
    const base64 = encodeEmbedding([0.5, -1.25, 3]).toString("base64");
    const bytes = parseEmbedding(base64);
    expect(bytes).not.toBeNull();
    expect(Array.from(decodeEmbedding(bytes as Buffer))).toEqual([
      0.5, -1.25, 3,
    ]);
  });

  it("rejects ragged bytes, empty vectors and non-finite values", () => {
    expect(parseEmbedding(Buffer.alloc(6).toString("base64"))).toBeNull();
    expect(parseEmbedding("")).toBeNull();
    expect(
      parseEmbedding(encodeEmbedding([1, Number.NaN]).toString("base64")),
    ).toBeNull();
    expect(
      parseEmbedding(Buffer.alloc(4 * 4097).toString("base64")),
    ).toBeNull();
  });

  it("scores normalized vectors by cosine", () => {
    const a = normalize(new Float32Array([3, 4]));
    expect(dot(a, normalize(new Float32Array([6, 8])))).toBeCloseTo(1);
    expect(dot(a, normalize(new Float32Array([-4, 3])))).toBeCloseTo(0);
    expect(dot(a, new Float32Array([9, 9, 0.6, 0.8]), 2)).toBeCloseTo(1);
    expect(Array.from(normalize(new Float32Array([0, 0])))).toEqual([0, 0]);
  });
});
