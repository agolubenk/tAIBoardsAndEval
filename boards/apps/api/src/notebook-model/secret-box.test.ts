import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { canSealSecrets, openSecret, sealSecret } from "./secret-box";

// Synthetic server keys, 32+ characters like the real one.
const FIRST = "first-server-key-0123456789abcdef";
const ROTATED = "rotated-server-key-0123456789abcd";
const HERE = "https://openrouter.ai";

describe("settings secret box", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("seals a key that opens only under the same server key", () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", FIRST);
    const sealed = sealSecret("sk-or-v1-secret", HERE);
    expect(sealed).not.toContain("sk-or-v1-secret");
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(openSecret(sealed, HERE)).toBe("sk-or-v1-secret");

    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", ROTATED);
    expect(openSecret(sealed, HERE)).toBeNull();
  });

  it("opens only for the address it was sealed for", () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", FIRST);
    const sealed = sealSecret("sk-or-v1-secret", HERE);
    expect(openSecret(sealed, "https://collector.example")).toBeNull();
  });

  it("refuses to seal without a server key and opens nothing", () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY_FILE", "");
    expect(canSealSecrets()).toBe(false);
    expect(() => sealSecret("x", HERE)).toThrow();
    expect(openSecret("enc:v1:a.b.c", HERE)).toBeNull();
  });

  it("treats a short server key as none", () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "short-key");
    expect(canSealSecrets()).toBe(false);
  });

  it("rejects a tampered payload and a shortened tag", () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", FIRST);
    const sealed = sealSecret("value", HERE);
    expect(openSecret(`${sealed.slice(0, -2)}AA`, HERE)).toBeNull();
    expect(openSecret("plain", HERE)).toBeNull();

    const [iv, tag, body] = sealed.slice("enc:v1:".length).split(".");
    const shortTag = Buffer.from(String(tag), "base64url")
      .subarray(0, 4)
      .toString("base64url");
    expect(openSecret(`enc:v1:${iv}.${shortTag}.${body}`, HERE)).toBeNull();
  });
});
