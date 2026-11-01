import { isRecord } from "./entity.js";

const TEXT_KEYS = new Set([
  "description",
  "body",
  "content",
  "text",
  "comment",
  "reason",
]);
export const SUMMARY_CHARS = 280;

function summary(text: string) {
  const paragraph = text.trim().split(/\n\s*\n/)[0] ?? "";
  if (
    paragraph.length <= SUMMARY_CHARS &&
    paragraph.length === text.trim().length
  ) {
    return text;
  }
  return `${paragraph.slice(0, SUMMARY_CHARS).trimEnd()}…`;
}

// Long text fields shrink to their first paragraph (R-031); the full text
// comes from the same tool with summary off.
export function summarizeText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(summarizeText);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] =
      typeof child === "string" && TEXT_KEYS.has(key)
        ? summary(child)
        : summarizeText(child);
  }
  return out;
}
