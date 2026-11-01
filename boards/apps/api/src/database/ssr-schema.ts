// tAI-Boards SSR (spec prototipes/grill/taiboards-ssr/spec.md, approved
// 31.10): versioned registry of session settings, skills, rules, genomes,
// prompts and product prompts. Content-addressed blobs keep storage flat
// (RU-3 dedup), version bodies are immutable (RU-5) and every served file is
// verified against its sha256.
import { createId } from "@paralleldrive/cuid2";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { workspaceTable } from "./schema";

const utcNow = sql`(now() AT TIME ZONE 'utc')`;

// One row per distinct file content. sha256 is the primary key, so the same
// bytes are stored once no matter how many versions reference them.
export const ssrBlobTable = pgTable("ssr_blob", {
  sha256: text("sha256").primaryKey(),
  content: text("content").notNull(),
  bytes: integer("bytes").notNull(),
  createdAt: timestamp("created_at", { mode: "date" })
    .default(utcNow)
    .notNull(),
});

// An entity is what rolls back as a whole (D-008): a skill folder or one
// corpus file. `path` is the corpus path (skill = its folder path).
export const ssrEntityTable = pgTable(
  "ssr_entity",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    kind: text("kind").notNull(), // skill|rule|agent|genome|prompt|nerve|config|product-prompt
    name: text("name").notNull(),
    path: text("path").notNull(),
    status: text("status").notNull().default("active"), // active|archived
    latestVersionId: text("latest_version_id"),
    createdAt: timestamp("created_at", { mode: "date" })
      .default(utcNow)
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .default(utcNow)
      .notNull(),
  },
  (table) => [
    uniqueIndex("ssr_entity_ws_path_key").on(table.workspaceId, table.path),
    index("ssr_entity_ws_kind_idx").on(table.workspaceId, table.kind),
  ],
);

// A version is an immutable snapshot: the files map (path -> sha256) plus the
// aggregate sha of that map. Status: latest | superseded | draft | rejected.
// Origin: sync (auto-bump, Q-014) | owner (approval of a draft, Q-015) |
// rollback (restore, spec N-3).
export const ssrVersionTable = pgTable(
  "ssr_version",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    entityId: text("entity_id")
      .notNull()
      .references(() => ssrEntityTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    number: integer("number").notNull(),
    blobSha: text("blob_sha").notNull(),
    files: jsonb("files")
      .$type<Array<{ path: string; sha256: string; bytes: number }>>()
      .notNull(),
    status: text("status").notNull(),
    origin: text("origin").notNull(),
    commitSha: text("commit_sha"),
    message: text("message"),
    createdBy: text("created_by"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" })
      .default(utcNow)
      .notNull(),
  },
  (table) => [
    uniqueIndex("ssr_version_entity_number_key").on(
      table.entityId,
      table.number,
    ),
    index("ssr_version_entity_status_idx").on(table.entityId, table.status),
    index("ssr_version_created_idx").on(table.createdAt),
  ],
);

// Per-file push state: what the sync last saw in the repo (lastSyncedSha) and
// what push-back last wrote (lastPushedSha). A conditional push compares the
// repo's current sha with lastSyncedSha; a mismatch is a conflict (D-012),
// never a silent overwrite.
export const ssrPushStateTable = pgTable(
  "ssr_push_state",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    path: text("path").notNull(),
    lastSyncedSha: text("last_synced_sha").notNull(),
    lastPushedSha: text("last_pushed_sha"),
    lastPushedCommitSha: text("last_pushed_commit_sha"),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .default(utcNow)
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.path] }),
    index("ssr_push_state_ws_idx").on(table.workspaceId),
  ],
);

// An open conflict: the repo file changed outside the sync's knowledge while
// SSR held a different baseline. Surfaced in the SSR UI with the diff (RU-9,
// D-012); resolution marks it done.
export const ssrConflictTable = pgTable(
  "ssr_conflict",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    path: text("path").notNull(),
    baselineSha: text("baseline_sha").notNull(),
    repoSha: text("repo_sha").notNull(),
    latestSha: text("latest_sha"),
    status: text("status").notNull().default("open"), // open|resolved
    detectedAt: timestamp("detected_at", { mode: "date" })
      .default(utcNow)
      .notNull(),
    resolvedAt: timestamp("resolved_at", { mode: "date" }),
  },
  (table) => [
    index("ssr_conflict_ws_status_idx").on(table.workspaceId, table.status),
  ],
);
