import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { canSealSecrets, openSecret, sealSecret } from "./secret-box";

describe("settings secret box", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("seals a key that opens only under the same server key", () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "first-server-key");
    const sealed = sealSecret("sk-or-v1-secret");
    expect(sealed).not.toContain("sk-or-v1-secret");
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(openSecret(sealed)).toBe("sk-or-v1-secret");

    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "rotated-server-key");
    expect(openSecret(sealed)).toBeNull();
  });

  it("refuses to seal without a server key and opens nothing", () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY_FILE", "");
    expect(canSealSecrets()).toBe(false);
    expect(() => sealSecret("x")).toThrow();
    expect(openSecret("enc:v1:a.b.c")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "first-server-key");
    const sealed = sealSecret("value");
    expect(openSecret(`${sealed.slice(0, -2)}AA`)).toBeNull();
    expect(openSecret("plain")).toBeNull();
  });
});
