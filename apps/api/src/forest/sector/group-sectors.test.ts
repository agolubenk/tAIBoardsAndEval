import { describe, expect, it } from "vite-plus/test";
import { groupSectors, sectorSignature } from "./group-sectors";

describe("groupSectors", () => {
  it("joins chains of linked trees and drops lone ones", () => {
    const groups = groupSectors([
      { a: "t3", b: "t1" },
      { a: "t1", b: "t2" },
      { a: "t9", b: "t8" },
      { a: "t5", b: "t5" },
    ]);
    expect(groups).toEqual([
      ["t1", "t2", "t3"],
      ["t8", "t9"],
    ]);
  });

  it("returns nothing without links", () => {
    expect(groupSectors([])).toEqual([]);
  });
});

describe("sectorSignature", () => {
  it("ignores order and repeats", () => {
    expect(sectorSignature(["b", "a", "a"])).toBe(sectorSignature(["a", "b"]));
    expect(sectorSignature(["a", "b"])).not.toBe(sectorSignature(["a", "c"]));
  });
});
