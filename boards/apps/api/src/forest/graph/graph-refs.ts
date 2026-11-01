// Decisions on the graph are D-records and ADRs (R-020), cited by id in a
// card's title, description or report. Postgres ARE: \m and \M are word edges.
export const DECISION_PATTERN = String.raw`\m(D-[0-9]{3,4}|ADR[- ]?[0-9]{1,4})\M`;

// One card brings at most this many files and decisions onto the graph, so a
// card always fits a page of 100 nodes.
export const FILES_PER_CARD = 20;
export const DECISIONS_PER_CARD = 10;

// "src/a.ts:12-30", "src/a.ts#L12" and "src/a.ts" are one file on the graph.
export function filePath(raw: string) {
  return raw
    .trim()
    .replace(/#L\d+(?:-L?\d+)?$/, "")
    .replace(/:\d+(?::\d+)?(?:-\d+)?$/, "");
}

// "ADR 2", "ADR002" and "ADR-002" are one decision.
export function decisionRef(raw: string) {
  const adr = /^ADR[- ]?(\d+)$/.exec(raw);
  return adr?.[1] ? `ADR-${adr[1].padStart(3, "0")}` : raw;
}

// Distinct non-empty values, sorted, at most `cap` of them.
export function capDistinct(values: string[], cap: number) {
  return [...new Set(values.filter(Boolean))].sort().slice(0, cap);
}
