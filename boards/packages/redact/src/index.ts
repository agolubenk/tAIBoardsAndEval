export type SecretKind =
  | "api_key"
  | "jwt"
  | "pem"
  | "db_url"
  | "bearer"
  | "base64_blob"
  | "password_assignment";

export type RedactHit = { kind: SecretKind; start: number; end: number };

type Detector = (text: string) => RedactHit[];

function collect(pattern: RegExp, kind: SecretKind): Detector {
  return (text) => {
    const hits: RedactHit[] = [];
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      hits.push({ kind, start, end: start + match[0].length });
    }
    return hits;
  };
}

// Replaces only group 1 of each match, keeping the surrounding context
// (header name, assignment key, quotes) readable.
function collectGroup(
  pattern: RegExp,
  kind: SecretKind,
  group: number,
): Detector {
  return (text) => {
    const hits: RedactHit[] = [];
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[group];
      if (value === undefined) continue;
      const start = match.index + match[0].indexOf(value);
      hits.push({ kind, start, end: start + value.length });
    }
    return hits;
  };
}

const pem = collect(
  /-----BEGIN [A-Z0-9 ]*KEY-----[\s\S]*?-----END [A-Z0-9 ]*KEY-----/g,
  "pem",
);

const dbUrl = collect(
  /(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^\s"'`/]*:[^\s@"'`]+@[^\s"'`]+/gi,
  "db_url",
);

const bearer = collectGroup(
  /Authorization\s*:\s*Bearer\s+(?!\[REDACTED)([^\s"']+)/gi,
  "bearer",
  1,
);

// JWTs always start with eyJ (base64url of `{"`), which keeps plain
// dotted strings out of scope.
const jwt = collect(
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}(?![A-Za-z0-9_-])/g,
  "jwt",
);

const apiKey = collect(
  /(?<![A-Za-z0-9])(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35})(?![A-Za-z0-9_-])/g,
  "api_key",
);

// Lowercase-insensitive password/passwd/pwd cover JSON and config syntax;
// SECRET is uppercase-only (env-var style) so prose like
// "the secret: ..." survives.
const passwordAssignment = collectGroup(
  /(?:["']?(?:password|passwd|pwd)["']?\s*[:=]\s*)["']?(?!\[REDACTED)([^"'\s]+)/gi,
  "password_assignment",
  1,
);

const secretAssignment = collectGroup(
  /(?:["']?SECRET["']?\s*=\s*)["']?(?!\[REDACTED)([^"'\s]+)/g,
  "password_assignment",
  1,
);

// Long runs of the base64 alphabet that mix upper/lower/digit and carry
// high Shannon entropy are almost always encoded key material. Hex digests
// (git SHA, sha256) are single-case and UUIDs contain dashes, so neither
// reaches this detector.
const BASE64_BLOB_MIN_LENGTH = 64;
const BASE64_BLOB_MIN_ENTROPY = 4.5;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const base64Blob: Detector = (text) => {
  const hits: RedactHit[] = [];
  const pattern = new RegExp(
    `[A-Za-z0-9+/]{${BASE64_BLOB_MIN_LENGTH},}={0,2}`,
    "g",
  );
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/[0-9]/.test(token)) {
      continue;
    }
    if (shannonEntropy(token) < BASE64_BLOB_MIN_ENTROPY) continue;
    hits.push({
      kind: "base64_blob",
      start: match.index,
      end: match.index + token.length,
    });
  }
  return hits;
};

// Order matters: earlier detectors win overlaps (a PEM body is also a valid
// base64 blob, a JWT inside a Bearer header stays one hit).
const detectors: Detector[] = [
  pem,
  dbUrl,
  bearer,
  jwt,
  apiKey,
  passwordAssignment,
  secretAssignment,
  base64Blob,
];

export function redact(text: string): { text: string; hits: RedactHit[] } {
  const accepted: RedactHit[] = [];
  for (const detector of detectors) {
    for (const hit of detector(text)) {
      accepted.push(hit);
    }
  }
  accepted.sort((a, b) => a.start - b.start || b.end - a.end);

  const hits: RedactHit[] = [];
  let cursor = 0;
  for (const hit of accepted) {
    if (hit.start < cursor) continue;
    hits.push(hit);
    cursor = hit.end;
  }

  let result = "";
  cursor = 0;
  for (const hit of hits) {
    result += text.slice(cursor, hit.start);
    result += `[REDACTED:${hit.kind}]`;
    cursor = hit.end;
  }
  result += text.slice(cursor);

  return { text: result, hits };
}
