import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { resolveFileSecret } from "../utils/file-secret";

// Same sealed format as the notification secrets, under its own server key
// (SETTINGS_ENCRYPTION_KEY or SETTINGS_ENCRYPTION_KEY_FILE): a database dump
// alone never reveals a stored model key.
const PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function settingsKey(): Buffer | null {
  let raw: string | undefined;
  try {
    raw = resolveFileSecret("SETTINGS_ENCRYPTION_KEY")?.trim();
  } catch {
    return null;
  }
  return raw ? createHash("sha256").update(raw).digest() : null;
}

export function canSealSecrets() {
  return settingsKey() !== null;
}

export function sealSecret(value: string): string {
  const key = settingsKey();
  if (!key) throw new Error("SETTINGS_ENCRYPTION_KEY is not configured");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const sealed = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${PREFIX}${[iv, cipher.getAuthTag(), sealed]
    .map((part) => part.toString("base64url"))
    .join(".")}`;
}

// Null when the server key is missing or was changed since sealing: the
// administrator enters the model key again.
export function openSecret(value: string): string | null {
  const key = settingsKey();
  if (!key || !value.startsWith(PREFIX)) return null;
  const [iv, tag, sealed] = value
    .slice(PREFIX.length)
    .split(".")
    .map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !sealed) return null;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(sealed), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    return null;
  }
}
