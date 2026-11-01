import type { CardMetaPatch } from "@/fetchers/forest/update-card-meta";
import type { CardMeta } from "./card-types";

// The edit form keeps every field as text; lists are one item per line.
export type MetaDraft = {
  kind: CardMeta["kind"];
  severity: string;
  backlogId: string;
  halfBaked: boolean;
  report: string;
  executor: string;
  branch: string;
  pullRequests: string;
  files: string;
  tokens: string;
  costUsd: string;
  contextPack: string;
};

export const NOTION_DRAFT_FIELDS = [
  "kind",
  "severity",
  "backlogId",
  "halfBaked",
  "report",
] as const;

export function toMetaDraft(meta: CardMeta): MetaDraft {
  return {
    kind: meta.kind,
    severity: meta.severity ?? "",
    backlogId: meta.backlogId ?? "",
    halfBaked: meta.halfBaked,
    report: meta.report ?? "",
    executor: meta.executor ?? "",
    branch: meta.branch ?? "",
    pullRequests: meta.pullRequests.join("\n"),
    files: meta.files.join("\n"),
    tokens: meta.tokens === null ? "" : String(meta.tokens),
    costUsd: meta.costUsd === null ? "" : String(meta.costUsd),
    contextPack: meta.contextPack ?? "",
  };
}

const text = (value: string) => value.trim() || null;
const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((item, i) => item === b[i]);

function parseNumber(value: string, integer: boolean) {
  const trimmed = value.trim().replace(",", ".");
  if (!trimmed) return null;
  const number = Number(trimmed);
  if (!Number.isFinite(number) || number < 0) return undefined;
  if (integer && !Number.isInteger(number)) return undefined;
  return number;
}

// Only the fields that changed, so a save never rewrites what the form did
// not touch (and a mirrored card's Notion fields are never sent).
export function draftToPatch(
  meta: CardMeta,
  draft: MetaDraft,
): { patch: CardMetaPatch; invalid: Array<"tokens" | "costUsd"> } {
  const patch: CardMetaPatch = {};
  const invalid: Array<"tokens" | "costUsd"> = [];

  if (draft.kind !== meta.kind) patch.kind = draft.kind;
  if (draft.halfBaked !== meta.halfBaked) patch.halfBaked = draft.halfBaked;
  for (const key of [
    "severity",
    "backlogId",
    "report",
    "executor",
    "branch",
    "contextPack",
  ] as const) {
    if (text(draft[key]) !== meta[key]) patch[key] = text(draft[key]);
  }
  for (const key of ["pullRequests", "files"] as const) {
    const next = lines(draft[key]);
    if (!sameList(next, meta[key])) patch[key] = next;
  }

  const tokens = parseNumber(draft.tokens, true);
  if (tokens === undefined) invalid.push("tokens");
  else if (tokens !== meta.tokens) patch.tokens = tokens;
  const cost = parseNumber(draft.costUsd, false);
  if (cost === undefined) invalid.push("costUsd");
  else if (cost !== meta.costUsd) patch.costUsd = cost;

  return { patch, invalid };
}
