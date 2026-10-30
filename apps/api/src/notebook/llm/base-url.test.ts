import { describe, expect, it } from "vite-plus/test";
import { isHttpsUrl, normalizeBaseUrl, urlOrigin } from "./base-url";

describe("notebook model address", () => {
  it("drops trailing slashes", () => {
    expect(normalizeBaseUrl(" https://gw.example/v1// ")).toBe(
      "https://gw.example/v1",
    );
  });

  it.each([
    ["https://openrouter.ai/api/v1", true],
    ["http://openrouter.ai/api/v1", false],
    ["ftp://x", false],
    ["not a url", false],
  ])("takes %s as https: %s", (url, expected) => {
    expect(isHttpsUrl(url)).toBe(expected);
  });

  it("binds to scheme, host and port, not the path", () => {
    expect(urlOrigin("https://openrouter.ai/api/v1")).toBe(
      urlOrigin("https://openrouter.ai/other"),
    );
    expect(urlOrigin("https://openrouter.ai/api/v1")).not.toBe(
      urlOrigin("https://openrouter.ai:8443/api/v1"),
    );
  });
});
