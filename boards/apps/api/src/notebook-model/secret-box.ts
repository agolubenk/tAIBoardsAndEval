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
const TAG_BYTES = 16;
// A shorter server key can be guessed; it counts as no key at all.
const MIN_KEY_LENGTH = 32;

function settingsKey(): Buffer | null {
  let raw: string | undefined;
  try {
    raw = resolveFileSecret("SETTINGS_ENCRYPTION_KEY")?.trim();
  } catch {
    return null;
  }
  return raw && raw.length >= MIN_KEY_LENGTH
    ? createHash("sha256").update(raw).digest()
    : null;
}

export function canSealSecrets() {
  return settingsKey() !== null;
}

// `context` is sealed in with the value: it opens only under the same context,
// so a model key stored for one API address is never sent to another.
export function sealSecret(value: string, context: string): string {
  const key = settingsKey();
  if (!key) throw new Error("SETTINGS_ENCRYPTION_KEY is not configured");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const sealed = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${PREFIX}${[iv, cipher.getAuthTag(), sealed]
    .map((part) => part.toString("base64url"))
    .join(".")}`;
}

// Null when the server key is missing or was changed since sealing, or the
// context differs: the administrator enters the model key again.
export function openSecret(value: string, context: string): string | null {
  const key = settingsKey();
  if (!key || !value.startsWith(PREFIX)) return null;
  const [iv, tag, sealed] = value
    .slice(PREFIX.length)
    .split(".")
    .map((part) => Buffer.from(part, "base64url"));
  // A short tag would let a forged value through with fewer guesses.
  if (iv?.length !== IV_BYTES || tag?.length !== TAG_BYTES || !sealed) {
    return null;
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(sealed), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    return null;
  }
}
