import { describe, expect, it } from "vite-plus/test";
import { decodeCursor, encodeCursor, pageSize } from "./page-cursor";

describe("page cursor", () => {
  it("round-trips a position", () => {
    const at = new Date("2026-10-27T10:00:00.000Z");
    expect(decodeCursor(encodeCursor({ at, id: "log1" }))).toEqual({
      at,
      id: "log1",
    });
  });

  it("rejects garbage and caps the page", () => {
    expect(() => decodeCursor("bm9wZQ")).toThrow("Invalid cursor");
    expect(decodeCursor(undefined)).toBeNull();
    expect(pageSize(5000)).toBe(100);
    expect(pageSize(undefined)).toBe(20);
  });
});
