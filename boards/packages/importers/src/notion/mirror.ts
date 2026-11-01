import type { ImportedProject } from "../types.js";
import { readSharedDatabase } from "./access.js";
import type { NotionDatabase, NotionPage } from "./api-types.js";
import { blocksToMarkdown } from "./body.js";
import type { NotionClient } from "./client.js";
import { mapDatabase } from "./mapping.js";

export type NotionMirrorRead = {
  database: NotionDatabase;
  pages: NotionPage[];
  project: ImportedProject;
};

export type ReadNotionMirrorOptions = {
  product: string;
  // Called once with every page, before any body is read; returns the ids
  // whose bodies to read. A page whose card is already current needs none:
  // the mirror rewrites a card only when Notion edited it since (R-080), so
  // skipping saves a request per page and keeps a scheduled run within
  // Notion's rate limit.
  selectBodies?: (
    pages: readonly NotionPage[],
  ) => ReadonlySet<string> | Promise<ReadonlySet<string>>;
  onProgress?: (message: string) => void;
};

// One read serves both the sync and the reconciliation (AC-002): the mapped
// project for the writer and the raw pages and database for `reconcile`.
export async function readNotionMirror(
  client: NotionClient,
  databaseId: string,
  options: ReadNotionMirrorOptions,
): Promise<NotionMirrorRead> {
  const { onProgress } = options;
  onProgress?.("Reading database");
  const database = await readSharedDatabase(client, databaseId);

  onProgress?.("Reading pages");
  const pages = await client.queryDatabase(databaseId, (count) =>
    onProgress?.(`Reading pages (${count} so far)`),
  );

  const selected = options.selectBodies
    ? await options.selectBodies(pages)
    : null;
  const wanted = selected
    ? pages.filter((page) => selected.has(page.id))
    : pages;
  const bodies = new Map<string, string>();
  let read = 0;
  for (const page of wanted) {
    read += 1;
    onProgress?.(`Reading page bodies (${read}/${wanted.length})`);
    bodies.set(page.id, blocksToMarkdown(await client.readBlockTree(page.id)));
  }

  return {
    database,
    pages,
    project: mapDatabase(database, pages, bodies, options.product),
  };
}
