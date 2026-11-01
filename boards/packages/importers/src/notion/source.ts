import type {
  ConnectOptions,
  ImportedProject,
  ImportSource,
  ReadProjectOptions,
  SourceProject,
} from "../types.js";
import { checkNotionToken, readSharedDatabase } from "./access.js";
import { plainText } from "./api-types.js";
import { NotionClient } from "./client.js";
import { DEFAULT_PRODUCT } from "./idempotency.js";
import { readNotionMirror } from "./mirror.js";

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
  await checkNotionToken(client);

  return {
    async listProjects(): Promise<SourceProject[]> {
      const projects: SourceProject[] = [];
      for (const databaseId of databaseIds) {
        const database = await readSharedDatabase(client, databaseId);
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
      const { project } = await readNotionMirror(
        client.withSignal(readOptions.signal),
        databaseId,
        { product, onProgress: readOptions.onProgress },
      );
      return project;
    },
  };
}
