import { describe, expect, it } from "vite-plus/test";
import { hashValue } from "./hash-value.js";

describe("hashValue", () => {
  it("does not depend on key order or undefined fields", () => {
    expect(hashValue({ a: 1, b: [{ c: 2, d: 3 }] })).toBe(
      hashValue({ b: [{ d: 3, c: 2 }], a: 1, e: undefined }),
    );
  });

  it("changes with the data", () => {
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
    expect(hashValue([1, 2])).not.toBe(hashValue([2, 1]));
  });

  it("is a short hex tag", () => {
    expect(hashValue(null)).toMatch(/^[0-9a-f]{16}$/);
  });
});
