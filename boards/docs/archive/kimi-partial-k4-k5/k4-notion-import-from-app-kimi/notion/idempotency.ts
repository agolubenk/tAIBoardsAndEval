// Idempotency key of an imported Notion page: product namespace + system +
// page id. Re-importing the same page yields the same key, so the writer can
// upsert instead of duplicating (AC-026).
export function notionIdempotencyKey(product: string, pageId: string): string {
  return `${product}:notion:${pageId}`;
}

export const NOTION_KEY_PATTERN = /:notion:([^:]+)$/;

export function pageIdFromKey(key: string): string | undefined {
  return NOTION_KEY_PATTERN.exec(key)?.[1];
}

export const DEFAULT_PRODUCT = "default";
