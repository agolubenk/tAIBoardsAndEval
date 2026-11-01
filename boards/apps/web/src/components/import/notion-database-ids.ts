// Notion shows a database as a URL (`…/Tasks-<32 hex>?v=…`) or a dashed UUID;
// both reduce to the same 32 hex characters the API accepts.
const NOTION_ID =
  /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi;

export function parseNotionDatabaseIds(text: string): string[] {
  const ids = new Set<string>();
  for (const entry of text.split(/[\s,]+/)) {
    const path = entry.split("?")[0] ?? "";
    const matches = path.match(NOTION_ID);
    const last = matches?.at(-1);
    if (last) ids.add(last.replaceAll("-", "").toLowerCase());
  }
  return [...ids];
}
