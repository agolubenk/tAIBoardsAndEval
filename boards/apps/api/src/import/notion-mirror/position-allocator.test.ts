import { describe, expect, it } from "vite-plus/test";
import { createPositionAllocator } from "./position-allocator";

describe("createPositionAllocator", () => {
  it("continues after each column's last card and counts statuses apart", () => {
    const next = createPositionAllocator([
      { columnId: "c1", status: "to-do", max: 4 },
      { columnId: null, status: "archived", max: 2 },
      { columnId: null, status: "planned", max: null },
    ]);
    expect(next({ columnId: "c1", status: "to-do" })).toBe(5);
    expect(next({ columnId: "c1", status: "to-do" })).toBe(6);
    expect(next({ columnId: null, status: "archived" })).toBe(3);
    expect(next({ columnId: null, status: "planned" })).toBe(1);
    expect(next({ columnId: "c2", status: "done" })).toBe(1);
  });
});
