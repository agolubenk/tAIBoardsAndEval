import { describe, expect, it } from "vite-plus/test";
import { formatChangeValue } from "./format-change-value";

const date = (iso: string) => `D(${iso.slice(0, 10)})`;

describe("formatChangeValue", () => {
  it("treats empty values as missing", () => {
    expect(formatChangeValue(null, date)).toBeNull();
    expect(formatChangeValue("", date)).toBeNull();
    expect(formatChangeValue([], date)).toBeNull();
  });

  it("formats dates, lists, booleans and long text", () => {
    expect(formatChangeValue("2026-10-28T10:00:00.000Z", date)).toBe(
      "D(2026-10-28)",
    );
    expect(formatChangeValue(["a.ts", "b.ts"], date)).toBe("a.ts, b.ts");
    expect(formatChangeValue(true, date)).toBe("true");
    const long = formatChangeValue(`line\n${"x".repeat(200)}`, date);
    expect(long?.startsWith("line x")).toBe(true);
    expect(long?.endsWith("…")).toBe(true);
    expect(long?.length).toBe(121);
  });
});
