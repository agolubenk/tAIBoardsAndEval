// Ingest-time secret scan (spec RU-4): a version whose files match a known
// credential pattern is rejected before any blob is served, and the caller
// gets the offending paths back to fix at the source.
const PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "github-pat", regex: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { label: "github-fine-grained", regex: /github_pat_[A-Za-z0-9_]{20,}/g },
  { label: "openai-key", regex: /sk-[A-Za-z0-9_-]{20,}/g },
  { label: "anthropic-key", regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { label: "aws-access-key", regex: /AKIA[0-9A-Z]{16}/g },
  { label: "slack-token", regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { label: "google-api-key", regex: /AIza[0-9A-Za-z_-]{30,}/g },
  {
    label: "private-key",
    regex: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  { label: "notion-token", regex: /secret_[A-Za-z0-9]{30,}/g },
  { label: "telegram-bot-token", regex: /\d{8,10}:AA[A-Za-z0-9_-]{30,}/g },
];

export function scanSecrets(
  files: Array<{ path: string; content: string }>,
): Array<{ path: string; label: string }> {
  const hits: Array<{ path: string; label: string }> = [];
  for (const file of files) {
    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(file.content)) {
        hits.push({ path: file.path, label: pattern.label });
      }
    }
  }
  return hits;
}
