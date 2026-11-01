import { SourceHttpError } from "../http.js";
import { SourceAccessError } from "../source-access-error.js";
import type { NotionDatabase, NotionUser } from "./api-types.js";
import type { NotionClient } from "./client.js";

// A new internal integration signs in fine but sees nothing until a database
// is shared with it, and Notion answers that with the same 404 as a wrong ID.
// These checks tell the token apart from the database and name the step.
export const NOTION_ACCESS_CODES = {
  tokenInvalid: "NOTION_TOKEN_INVALID",
  contentUnreadable: "NOTION_CONTENT_UNREADABLE",
  nothingShared: "NOTION_NOTHING_SHARED",
  databaseNotShared: "NOTION_DATABASE_NOT_SHARED",
  notADatabase: "NOTION_NOT_A_DATABASE",
} as const;

const SHARE_STEP =
  "Open the database in Notion, then ⋯ › Connections, and add the integration.";

function httpStatus(error: unknown) {
  return error instanceof SourceHttpError ? error.status : null;
}

function notionMessage(error: unknown) {
  const body = error instanceof SourceHttpError ? error.body : null;
  return body &&
    typeof body === "object" &&
    "message" in body &&
    typeof body.message === "string"
    ? body.message
    : "";
}

export async function checkNotionToken(
  client: NotionClient,
): Promise<NotionUser> {
  try {
    return await client.me();
  } catch (error) {
    if (httpStatus(error) !== 401) throw error;
    throw new SourceAccessError(
      NOTION_ACCESS_CODES.tokenInvalid,
      "Notion did not accept this integration token. Copy the Internal Integration Secret again from the integration's page in Notion.",
    );
  }
}

export async function readSharedDatabase(
  client: NotionClient,
  databaseId: string,
): Promise<NotionDatabase> {
  try {
    return await client.getDatabase(databaseId);
  } catch (error) {
    throw await describeDatabaseRefusal(client, databaseId, error);
  }
}

async function describeDatabaseRefusal(
  client: NotionClient,
  databaseId: string,
  error: unknown,
): Promise<unknown> {
  const status = httpStatus(error);
  if (status === 403) {
    return new SourceAccessError(
      NOTION_ACCESS_CODES.contentUnreadable,
      "The token works, but the integration may not read content. In Notion, open the integration's Capabilities and turn on Read content.",
    );
  }
  if (
    status === 400 &&
    /is a page, not a database/i.test(notionMessage(error))
  ) {
    return new SourceAccessError(
      NOTION_ACCESS_CODES.notADatabase,
      `${databaseId} is a page, not a database. Open the database as a full page and copy its link.`,
      databaseId,
    );
  }
  if (status !== 404) return error;

  // Only on this failure path: one search page says whether anything at all
  // is shared, which is the usual state of a token made minutes ago.
  // A failed search falls back to the per-database text, but a cancelled
  // import stays cancelled.
  const anyShared = await client.hasSharedDatabase().catch((searchError) => {
    if (client.aborted) throw searchError;
    return true;
  });
  return anyShared
    ? new SourceAccessError(
        NOTION_ACCESS_CODES.databaseNotShared,
        `The token works, but database ${databaseId} is not shared with the integration, or the link is wrong. ${SHARE_STEP}`,
        databaseId,
      )
    : new SourceAccessError(
        NOTION_ACCESS_CODES.nothingShared,
        `The token works, but no database is shared with the integration yet. ${SHARE_STEP}`,
      );
}
