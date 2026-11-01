// Where a Notion refusal belongs in the form and the copy for it. The API
// names each case by code (packages/importers/src/notion/access.ts); anything
// else stays under the token with the server's own message. A refusal of one
// database among several names it with `namedMessageKey` when the API sends it.
export type NotionConnectError = {
  field: "token" | "databases";
  messageKey: string | null;
  namedMessageKey?: string;
};

const ERRORS = new Map<string, NotionConnectError>(
  Object.entries({
    NOTION_TOKEN_INVALID: {
      field: "token",
      messageKey: "settings:workspaceImport.notion.errors.tokenInvalid",
    },
    NOTION_CONTENT_UNREADABLE: {
      field: "token",
      messageKey: "settings:workspaceImport.notion.errors.contentUnreadable",
    },
    NOTION_NOTHING_SHARED: {
      field: "databases",
      messageKey: "settings:workspaceImport.notion.errors.nothingShared",
    },
    NOTION_DATABASE_NOT_SHARED: {
      field: "databases",
      messageKey: "settings:workspaceImport.notion.errors.databaseNotShared",
      namedMessageKey:
        "settings:workspaceImport.notion.errors.databaseNotSharedNamed",
    },
    NOTION_NOT_A_DATABASE: {
      field: "databases",
      messageKey: "settings:workspaceImport.notion.errors.notADatabase",
      namedMessageKey:
        "settings:workspaceImport.notion.errors.notADatabaseNamed",
    },
  }),
);

export function notionConnectError(
  code: string | null | undefined,
): NotionConnectError {
  return (code && ERRORS.get(code)) || { field: "token", messageKey: null };
}
