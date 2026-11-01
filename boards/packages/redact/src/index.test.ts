import { describe, expect, it } from "vite-plus/test";
import { redact } from "./index";

// Test secrets are assembled at runtime from fragments so this file carries
// no string that a secret scanner could mistake for live material.
function join(...parts: string[]): string {
  return parts.join("");
}

const secrets = {
  openai: join("sk", "-", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4"),
  anthropic: join("sk", "-ant-", "x9Y8w7V6u5T4s3R2q1P0o9N8m7"),
  ghp: join("gh", "p_", "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1W"),
  gho: join("gh", "o_", "Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe"),
  githubPat: join(
    "github",
    "_pat_",
    "11ABCDEFGH22",
    "_",
    "Za9Yb8Xc7Wd6Ve5Uf4Tg3Sh2Ri1Qj0Pk9Ol8Nm7Mn6Lk5J",
  ),
  slackBot: join("xox", "b-", "123456789012", "-", "abcdefABCDEF"),
  aws: join("AK", "IA", "IOSFODNN7EXAMPLE"),
  gitlab: join("gl", "pat-", "AbCdEfGhIjKlMnOpQrSt"),
  google: join("AI", "za", "SyD4eF6gH8jK0lM2nB4vC6xZ8aS0dF2gH4j"),
  jwt: join(
    "eyJ",
    "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    ".eyJ",
    "zdWIiOiIxMjM0NTY3ODkwIn0",
    ".",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
  ),
  pem: join(
    "-----BEGIN ",
    "PRIVATE KEY-----",
    "\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASC",
    "BKwwggjkAgEAAoIBAQC7\n",
    "-----END ",
    "PRIVATE KEY-----",
  ),
  postgresUrl: join(
    "postgres",
    "://",
    "app",
    ":",
    "s3cr3t",
    "@db.internal:5432/prod",
  ),
  redisUrl: join("redis", "://", ":", "s3cr3t", "@cache.internal:6379"),
  mongoUrl: join(
    "mongodb",
    "+srv",
    "://",
    "app",
    ":",
    "s3cr3t",
    "@cluster0.example.net/db",
  ),
  bearer: join("Authorization", ": ", "Bearer", " ", "mF_9.B5f-4.1JqM"),
  base64Blob: join(
    "bW91",
    "bnRhaW5zLWFyZS1oaWdoLWFuZC13aWxkLXNlY3JldHMtYXJl",
    "LWRlZXAtdGhlLXRva2Vucy1hcmUtd2lkZS1hbmQtbG9uZw",
  ),
};

function expectSingleHit(
  input: string,
  kind: string,
  secret: string,
): { text: string; hits: { kind: string; start: number; end: number }[] } {
  const result = redact(input);
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0]?.kind).toBe(kind);
  expect(result.hits[0]?.start).toBe(input.indexOf(secret));
  expect(result.hits[0]?.end).toBe(input.indexOf(secret) + secret.length);
  expect(result.text).toBe(input.replace(secret, `[REDACTED:${kind}]`));
  expect(result.text).not.toContain(secret);
  return result;
}

describe("@kaneo/redact", () => {
  describe("api_key", () => {
    it.each([
      ["OpenAI", secrets.openai],
      ["Anthropic", secrets.anthropic],
      ["GitHub classic", secrets.ghp],
      ["GitHub OAuth", secrets.gho],
      ["GitHub fine-grained", secrets.githubPat],
      ["Slack", secrets.slackBot],
      ["AWS", secrets.aws],
      ["GitLab", secrets.gitlab],
      ["Google", secrets.google],
    ])("redacts %s keys", (_name, secret) => {
      expectSingleHit(`token = ${secret} `, "api_key", secret);
    });
  });

  it("redacts JWTs", () => {
    expectSingleHit(`jwt: ${secrets.jwt}\n`, "jwt", secrets.jwt);
  });

  it("redacts PEM blocks including newlines", () => {
    expectSingleHit(`key file:\n${secrets.pem}\nend`, "pem", secrets.pem);
  });

  describe("db_url", () => {
    it.each([
      ["postgres", secrets.postgresUrl],
      ["redis", secrets.redisUrl],
      ["mongodb+srv", secrets.mongoUrl],
    ])("redacts %s connection strings", (_name, secret) => {
      expectSingleHit(`DATABASE_URL=${secret}\n`, "db_url", secret);
    });
  });

  it("redacts bearer tokens but keeps the header name", () => {
    expectSingleHit(`header ${secrets.bearer}`, "bearer", "mF_9.B5f-4.1JqM");
  });

  describe("password_assignment", () => {
    it.each([
      ["env style", `password=${"s3cr3t-value"}`, "s3cr3t-value"],
      ["JSON style", `{"password": "${"s3cr3t-value"}"}`, "s3cr3t-value"],
      ["uppercase env", `SECRET=${"s3cr3t-value"}`, "s3cr3t-value"],
      ["yaml style", `passwd: ${"s3cr3t-value"}`, "s3cr3t-value"],
    ])("redacts %s", (_name, input, value) => {
      const result = redact(input);
      expect(result.text).toContain("[REDACTED:password_assignment]");
      expect(result.text).not.toContain(value);
      expect(result.hits[0]?.kind).toBe("password_assignment");
    });
  });

  it("redacts high-entropy base64 blobs", () => {
    expectSingleHit(
      `data: ${secrets.base64Blob}`,
      "base64_blob",
      secrets.base64Blob,
    );
  });

  it("reports hits in document order and keeps surrounding text", () => {
    const input = `a ${secrets.openai} b ${secrets.jwt} c`;
    const result = redact(input);
    expect(result.hits.map((hit) => hit.kind)).toEqual(["api_key", "jwt"]);
    expect(result.text).toBe(`a [REDACTED:api_key] b [REDACTED:jwt] c`);
  });

  it("treats a PEM body as one pem hit, not many base64 blobs", () => {
    const result = redact(secrets.pem);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.kind).toBe("pem");
  });

  it("is idempotent — redacting an already redacted text finds nothing", () => {
    const once = redact(`key ${secrets.openai} pass password=x1y2z3`);
    const twice = redact(once.text);
    expect(twice.hits).toHaveLength(0);
    expect(twice.text).toBe(once.text);
  });

  describe("false positives", () => {
    it("leaves git SHAs, UUIDs and sha256 digests untouched", () => {
      const sha = "a".charCodeAt(0);
      const gitSha = Array.from({ length: 40 }, (_, i) =>
        ((sha + i * 7) % 16).toString(16),
      ).join("");
      const sha256 = Array.from({ length: 64 }, (_, i) =>
        ((sha + i * 5) % 16).toString(16),
      ).join("");
      const uuid = "3f8a2b1c-4d5e-4f60-9a8b-7c6d5e4f3a2b";
      const input = `commit ${gitSha} digest ${sha256} id ${uuid}`;
      const result = redact(input);
      expect(result.hits).toHaveLength(0);
      expect(result.text).toBe(input);
    });

    it("leaves ordinary prose about secrets untouched", () => {
      const input = "The secret: Alice told Bob a story about passwords.";
      const result = redact(input);
      expect(result.hits).toHaveLength(0);
      expect(result.text).toBe(input);
    });
  });

  // AC-023 known miss, pinned by this test: an unprefixed key in YAML
  // (no known prefix, plain alnum so the base64-blob detector skips it)
  // is intentionally NOT redacted. Widening coverage here is a spec
  // decision, not a drive-by fix.
  it("known miss: unprefixed key in YAML is not redacted", () => {
    const unprefixed = "openaiKey: z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4";
    const result = redact(unprefixed);
    expect(result.hits).toHaveLength(0);
    expect(result.text).toBe(unprefixed);
  });

  it("handles empty input", () => {
    expect(redact("")).toEqual({ text: "", hits: [] });
  });
});
