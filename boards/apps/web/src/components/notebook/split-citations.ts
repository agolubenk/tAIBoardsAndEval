// `at` is where the part starts in the answer: a stable key for rendering.
export type AnswerPart =
  | { kind: "text"; at: number; text: string }
  | { kind: "cite"; at: number; n: number };

// Splits an answer into text and its [n] markers. Only numbers that match a
// citation become links; anything else, like "[2024]", stays text.
export function splitCitations(
  content: string,
  known: ReadonlySet<number>,
): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let last = 0;
  for (const match of content.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(match[1]);
    if (!known.has(n)) continue;
    if (match.index > last) {
      parts.push({
        kind: "text",
        at: last,
        text: content.slice(last, match.index),
      });
    }
    parts.push({ kind: "cite", at: match.index, n });
    last = match.index + match[0].length;
  }
  if (last < content.length) {
    parts.push({ kind: "text", at: last, text: content.slice(last) });
  }
  return parts;
}
