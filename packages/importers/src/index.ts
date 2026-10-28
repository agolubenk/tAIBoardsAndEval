import { connectJira, type JiraCredentials } from "./jira/index.js";
import { connectKaneo, type KaneoCredentials } from "./kaneo/index.js";
import { connectLinear, type LinearCredentials } from "./linear/index.js";
import { connectNotion, type NotionCredentials } from "./notion/index.js";
import { connectPlane, type PlaneCredentials } from "./plane/index.js";
import { connectPlanka, type PlankaCredentials } from "./planka/index.js";
import { connectTrello, type TrelloCredentials } from "./trello/index.js";
import type { ConnectOptions, ImportSource } from "./types.js";

export { normalizeBaseUrl, SourceHttpError } from "./http.js";
export { type JiraSite, parseJiraUrl } from "./jira/index.js";
export {
  DEFAULT_PRODUCT as NOTION_DEFAULT_PRODUCT,
  NotionClient,
  type NotionDatabase,
  type NotionMirrorRead,
  type NotionPage,
  notionIdempotencyKey,
  readNotionMirror,
  reconcile as reconcileNotion,
  type ReconcileDiscrepancy as NotionReconcileDiscrepancy,
  type ReconcileReport as NotionReconcileReport,
  type ReconcileSide as NotionReconcileSide,
  typeNameOf as notionTypeNameOf,
} from "./notion/index.js";
export {
  SOURCE_PROJECT_KEY_MAX,
  sanitizeProjectKey,
  toProjectKey,
  uniqueKey,
} from "./keys.js";
export { trelloAuthorizeUrl } from "./trello/index.js";
export type * from "./types.js";
export type {
  JiraCredentials,
  KaneoCredentials,
  LinearCredentials,
  NotionCredentials,
  PlaneCredentials,
  PlankaCredentials,
  TrelloCredentials,
};

export const IMPORT_SOURCE_IDS = [
  "planka",
  "plane",
  "linear",
  "jira",
  "trello",
  "kaneo",
  "notion",
] as const;

export type ImportSourceId = (typeof IMPORT_SOURCE_IDS)[number];

export type ImportCredentials = {
  planka: PlankaCredentials;
  plane: PlaneCredentials;
  linear: LinearCredentials;
  jira: JiraCredentials;
  trello: TrelloCredentials;
  kaneo: KaneoCredentials;
  notion: NotionCredentials;
};

export type ImportConnection = {
  [Source in ImportSourceId]: { source: Source } & ImportCredentials[Source];
}[ImportSourceId];

export function connectSource(
  connection: ImportConnection,
  options: ConnectOptions = {},
): Promise<ImportSource> {
  switch (connection.source) {
    case "planka":
      return connectPlanka(connection, options);
    case "plane":
      return connectPlane(connection, options);
    case "linear":
      return connectLinear(connection, options);
    case "jira":
      return connectJira(connection, options);
    case "trello":
      return connectTrello(connection, options);
    case "kaneo":
      return connectKaneo(connection, options);
    case "notion":
      return connectNotion(connection, options);
  }
}
