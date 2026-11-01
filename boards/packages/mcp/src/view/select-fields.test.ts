import { describe, expect, it } from "vite-plus/test";
import { selectFields } from "./select-fields.js";

describe("selectFields", () => {
  it("returns the value untouched without fields", () => {
    const value = { id: "t1", title: "x" };

    expect(selectFields(value, [])).toBe(value);
  });

  it("keeps id, the named fields and child lists of each entity", () => {
    const value = {
      items: [
        {
          id: "t1",
          title: "One",
          description: "long",
          labels: [{ id: "l1", name: "bug", color: "#f00" }],
        },
      ],
      pagination: { page: 1, totalPages: 3 },
    };

    expect(selectFields(value, ["title", "name"])).toEqual({
      items: [{ id: "t1", title: "One", labels: [{ id: "l1", name: "bug" }] }],
      pagination: { page: 1, totalPages: 3 },
    });
  });
});
