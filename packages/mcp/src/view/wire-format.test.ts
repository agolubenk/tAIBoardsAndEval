import { describe, expect, it } from "vite-plus/test";
import { decodeWire, defaultCounter, encodeResponse } from "./wire-format.js";

const flat = {
  items: Array.from({ length: 20 }, (_, i) => ({
    id: `a${i}`,
    status: "pending",
    action: "close_task",
  })),
};
const nested = {
  columns: Array.from({ length: 4 }, (_, c) => ({
    id: `c${c}`,
    tasks: Array.from({ length: 3 }, (_, t) => ({
      id: `t${c}${t}`,
      labels: [{ id: "l1", name: "bug" }],
      assignee: { id: "u1", name: "Dev" },
    })),
  })),
};

describe("encodeResponse", () => {
  it("answers whichever wire is fewer tokens when none is asked (R-033)", () => {
    const table = encodeResponse(flat);
    const tree = encodeResponse(nested);

    expect(table.format).toBe("toon");
    expect(tree.format).toBe("json");
    for (const [encoded, value] of [
      [table, flat],
      [tree, nested],
    ] as const) {
      expect(decodeWire(encoded.text)).toEqual(value);
      const other = encodeResponse(value, {
        format: encoded.format === "toon" ? "json" : "toon",
      });
      expect(encoded.tokens).toBe(defaultCounter.count(encoded.text));
      expect(encoded.tokens).toBeLessThan(defaultCounter.count(other.text));
    }
  });

  it("keeps the asked wire", () => {
    expect(encodeResponse(nested, { format: "toon" }).format).toBe("toon");
    expect(encodeResponse(flat, { format: "json" }).format).toBe("json");
  });
});
