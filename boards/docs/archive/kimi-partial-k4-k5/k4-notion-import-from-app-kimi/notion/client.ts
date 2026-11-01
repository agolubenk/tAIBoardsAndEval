import { createJsonClient, type JsonClient } from "../http.js";
import type { FetchLike } from "../types.js";
import type {
  NotionBlock,
  NotionDatabase,
  NotionListResponse,
  NotionPage,
  NotionUser,
} from "./api-types.js";

export const NOTION_API_URL = "https://api.notion.com";
// 2025-09-03 is the first version that exposes `in_trash` on pages and blocks.
export const NOTION_VERSION = "2025-09-03";
// Notion caps `page_size` at 100.
export const NOTION_PAGE_SIZE = 100;

export type NotionClientOptions = {
  token: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
};

export class NotionClient {
  private readonly options: NotionClientOptions;
  private readonly http: JsonClient;

  constructor(options: NotionClientOptions) {
    this.options = options;
    this.http = createJsonClient({
      service: "Notion",
      baseUrl: NOTION_API_URL,
      headers: () => ({
        Authorization: `Bearer ${options.token}`,
        "Notion-Version": NOTION_VERSION,
      }),
      fetch: options.fetch,
      signal: options.signal,
      describeUnauthorized:
        "unauthorized (HTTP 401), check the Notion integration token and that it is shared with the databases",
    });
  }

  withSignal(signal: AbortSignal | undefined): NotionClient {
    if (!signal) return this;
    const current = this.options.signal;
    return new NotionClient({
      ...this.options,
      signal: current ? AbortSignal.any([current, signal]) : signal,
    });
  }

  me(): Promise<NotionUser> {
    return this.http.request<NotionUser>("/v1/users/me");
  }

  getDatabase(databaseId: string): Promise<NotionDatabase> {
    return this.http.request<NotionDatabase>(
      `/v1/databases/${encodeURIComponent(databaseId)}`,
    );
  }

  async queryDatabase(
    databaseId: string,
    onPage?: (count: number) => void,
  ): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];
    let cursor: string | null = null;
    do {
      const response = await this.http.request<NotionListResponse<NotionPage>>(
        `/v1/databases/${encodeURIComponent(databaseId)}/query`,
        {
          method: "POST",
          body: JSON.stringify({
            page_size: NOTION_PAGE_SIZE,
            ...(cursor ? { start_cursor: cursor } : {}),
            // Stable order lets an interrupted import resume and diff.
            sorts: [
              { timestamp: "last_edited_time", direction: "ascending" },
            ],
          }),
        },
      );
      pages.push(...response.results);
      onPage?.(pages.length);
      cursor = response.has_more ? response.next_cursor : null;
    } while (cursor);
    return pages;
  }

  async listBlockChildren(
    blockId: string,
    onPage?: (count: number) => void,
  ): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({
        page_size: String(NOTION_PAGE_SIZE),
      });
      if (cursor) params.set("start_cursor", cursor);
      const response = await this.http.request<NotionListResponse<NotionBlock>>(
        `/v1/blocks/${encodeURIComponent(blockId)}/children?${params}`,
      );
      blocks.push(...response.results);
      onPage?.(blocks.length);
      cursor = response.has_more ? response.next_cursor : null;
    } while (cursor);
    return blocks;
  }

  async readBlockTree(
    blockId: string,
    onChildren?: (blockId: string, blocks: NotionBlock[]) => void,
  ): Promise<NotionBlock[]> {
    const blocks = await this.listBlockChildren(blockId);
    onChildren?.(blockId, blocks);
    for (const block of blocks) {
      if (block.has_children) {
        block.children = await this.readBlockTree(block.id, onChildren);
      }
    }
    return blocks;
  }
}
