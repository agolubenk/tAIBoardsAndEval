CREATE TABLE "ssr_blob" (
	"sha256" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ssr_conflict" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"path" text NOT NULL,
	"baseline_sha" text NOT NULL,
	"repo_sha" text NOT NULL,
	"latest_sha" text,
	"status" text DEFAULT 'open' NOT NULL,
	"detected_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "ssr_entity" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"latest_version_id" text,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	"updated_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ssr_push_state" (
	"workspace_id" text NOT NULL,
	"path" text NOT NULL,
	"last_synced_sha" text NOT NULL,
	"last_pushed_sha" text,
	"last_pushed_commit_sha" text,
	"updated_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	CONSTRAINT "ssr_push_state_workspace_id_path_pk" PRIMARY KEY("workspace_id","path")
);
--> statement-breakpoint
CREATE TABLE "ssr_version" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"number" integer NOT NULL,
	"blob_sha" text NOT NULL,
	"files" jsonb NOT NULL,
	"status" text NOT NULL,
	"origin" text NOT NULL,
	"commit_sha" text,
	"message" text,
	"created_by" text,
	"approved_by" text,
	"approved_at" timestamp,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ssr_conflict" ADD CONSTRAINT "ssr_conflict_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ssr_entity" ADD CONSTRAINT "ssr_entity_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ssr_push_state" ADD CONSTRAINT "ssr_push_state_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ssr_version" ADD CONSTRAINT "ssr_version_entity_id_ssr_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."ssr_entity"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "ssr_conflict_ws_status_idx" ON "ssr_conflict" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ssr_entity_ws_path_key" ON "ssr_entity" USING btree ("workspace_id","path");--> statement-breakpoint
CREATE INDEX "ssr_entity_ws_kind_idx" ON "ssr_entity" USING btree ("workspace_id","kind");--> statement-breakpoint
CREATE INDEX "ssr_push_state_ws_idx" ON "ssr_push_state" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ssr_version_entity_number_key" ON "ssr_version" USING btree ("entity_id","number");--> statement-breakpoint
CREATE INDEX "ssr_version_entity_status_idx" ON "ssr_version" USING btree ("entity_id","status");--> statement-breakpoint
CREATE INDEX "ssr_version_created_idx" ON "ssr_version" USING btree ("created_at");