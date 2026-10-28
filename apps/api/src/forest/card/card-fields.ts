export const CARD_KINDS = ["task", "bug"] as const;

// Notion's own fields (R-024). A mirrored card keeps them read-only (R-081);
// on the owner's card an agent leaves them alone, as it does the text (N-004).
export const NOTION_FIELDS = [
  "kind",
  "severity",
  "backlogId",
  "halfBaked",
  "report",
] as const;

// What an agent reports about its work on the card (R-024).
export const AGENT_FIELDS = [
  "executor",
  "branch",
  "pullRequests",
  "files",
  "tokens",
  "costUsd",
  "contextPack",
] as const;

export type CardField =
  | (typeof NOTION_FIELDS)[number]
  | (typeof AGENT_FIELDS)[number];

export function isNotionField(field: CardField) {
  return (NOTION_FIELDS as readonly string[]).includes(field);
}
