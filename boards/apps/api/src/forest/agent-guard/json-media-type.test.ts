import { describe, expect, it } from "vite-plus/test";
import { isPlainJson } from "./json-media-type";

describe("isPlainJson", () => {
  it("accepts application/json with or without parameters", () => {
    expect(isPlainJson("application/json")).toBe(true);
    expect(isPlainJson("Application/JSON; charset=utf-8")).toBe(true);
  });

  it("refuses other JSON flavours and a missing header", () => {
    expect(isPlainJson("application/merge-patch+json")).toBe(false);
    expect(isPlainJson("text/plain")).toBe(false);
    expect(isPlainJson(undefined)).toBe(false);
  });
});
