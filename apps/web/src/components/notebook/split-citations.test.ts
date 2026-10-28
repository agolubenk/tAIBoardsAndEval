import { describe, expect, it } from "vite-plus/test";
import { splitCitations } from "./split-citations";

describe("splitCitations", () => {
  it("turns known markers into citations", () => {
    expect(splitCitations("Аренда [1], сроки [2].", new Set([1, 2]))).toEqual([
      { kind: "text", at: 0, text: "Аренда " },
      { kind: "cite", at: 7, n: 1 },
      { kind: "text", at: 10, text: ", сроки " },
      { kind: "cite", at: 18, n: 2 },
      { kind: "text", at: 21, text: "." },
    ]);
  });

  it("keeps unknown numbers and years as text", () => {
    expect(splitCitations("В [2024] и [7] [1]", new Set([1]))).toEqual([
      { kind: "text", at: 0, text: "В [2024] и [7] " },
      { kind: "cite", at: 15, n: 1 },
    ]);
  });

  it("handles adjacent markers and empty answers", () => {
    expect(splitCitations("[1][2]", new Set([1, 2]))).toEqual([
      { kind: "cite", at: 0, n: 1 },
      { kind: "cite", at: 3, n: 2 },
    ]);
    expect(splitCitations("", new Set([1]))).toEqual([]);
  });
});
