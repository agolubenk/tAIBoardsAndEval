import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@toon-format/toon", () => ({
  encode: () => {
    throw new Error("synthetic TOON codec failure");
  },
  decode: (text: string) => text,
}));

import { encodeResponse } from "./index";

describe("@kaneo/agent-format TOON fallback", () => {
  it("falls back to JSON with fallbackError on codec failure", () => {
    const value = { id: "T-1", title: "карточка" };
    const result = encodeResponse(value);
    expect(result.format).toBe("json");
    expect(result.fallbackError).toBe("synthetic TOON codec failure");
    expect(JSON.parse(result.text)).toEqual(value);
  });
});
