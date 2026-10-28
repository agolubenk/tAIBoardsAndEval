import type {
  ConnectOptions,
  ImportedProject,
  ImportSource,
  ReadProjectOptions,
  SourceProject,
} from "../types.js";
import { plainText } from "./api-types.js";
import { blocksToMarkdown } from "./body.js";
import { NotionClient } from "./client.js";
import { DEFAULT_PRODUCT } from "./idempotency.js";
import { mapDatabase } from "./mapping.js";

export type NotionCredentials = {
  token: string;
  databaseIds: string[];
  product?: string;
};

export async function connectNotion(
  credentials: NotionCredentials,
  options: ConnectOptions,
): Promise<ImportSource> {
  const token = credentials.token?.trim();
  if (!token) {
    throw new Error(
      "Enter a Notion integration token. Create one under Settings > Connections in Notion.",
    );
  }

  const databaseIds = [
    ...new Set(
      (credentials.databaseIds ?? [])
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  ];
  if (databaseIds.length === 0) {
    throw new Error("Add at least one Notion database ID to import from.");
  }

  const product = credentials.product?.trim() || DEFAULT_PRODUCT;
  const client = new NotionClient({
    token,
    fetch: options.fetch,
    signal: options.signal,
  });
  await client.me();

  return {
    async listProjects(): Promise<SourceProject[]> {
      const projects: SourceProject[] = [];
      for (const databaseId of databaseIds) {
        const database = await client.getDatabase(databaseId);
        const fields = Object.keys(database.properties).length;
        projects.push({
          id: database.id,
          name: plainText(database.title) || database.id,
          detail: `${fields} ${fields === 1 ? "field" : "fields"}`,
        });
      }
      return projects;
    },

    async readProject(
      databaseId: string,
      readOptions: ReadProjectOptions,
    ): Promise<ImportedProject> {
      const scoped = client.withSignal(readOptions.signal);
      const onProgress = readOptions.onProgress;

      onProgress?.("Reading database");
      const database = await scoped.getDatabase(databaseId);

      onProgress?.("Reading pages");
      const pages = await scoped.queryDatabase(databaseId, (count) =>
        onProgress?.(`Reading pages (${count} so far)`),
      );

      const bodies = new Map<string, string>();
      let read = 0;
      for (const page of pages) {
        read += 1;
        onProgress?.(`Reading page bodies (${read}/${pages.length})`);
        const blocks = await scoped.readBlockTree(page.id);
        bodies.set(page.id, blocksToMarkdown(blocks));
      }

      return mapDatabase(database, pages, bodies, product);
    },
  };
}
