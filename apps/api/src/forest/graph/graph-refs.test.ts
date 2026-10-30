import { describe, expect, it } from "vite-plus/test";
import { capDistinct, decisionRef, filePath } from "./graph-refs";

describe("filePath", () => {
  it("drops the line, so one file is one node", () => {
    expect(filePath(" src/a.ts:12-30 ")).toBe("src/a.ts");
    expect(filePath("src/a.ts:12:4")).toBe("src/a.ts");
    expect(filePath("src/a.ts#L12-L30")).toBe("src/a.ts");
    expect(filePath("src/a.ts")).toBe("src/a.ts");
  });
});

describe("decisionRef", () => {
  it("spells every ADR the same way and keeps D-records", () => {
    expect(decisionRef("ADR 2")).toBe("ADR-002");
    expect(decisionRef("ADR005")).toBe("ADR-005");
    expect(decisionRef("ADR-012")).toBe("ADR-012");
    expect(decisionRef("D-011")).toBe("D-011");
  });
});

describe("capDistinct", () => {
  it("drops repeats and blanks, then caps", () => {
    expect(capDistinct(["b", "a", "", "b", "c"], 2)).toEqual(["a", "b"]);
  });
});
