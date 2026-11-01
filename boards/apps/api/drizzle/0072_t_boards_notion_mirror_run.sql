CREATE TABLE "notion_mirror_run" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"discrepancy_count" integer DEFAULT 0 NOT NULL,
	"report" jsonb DEFAULT '{"databases":[]}'::jsonb NOT NULL,
	"started_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "notion_mirror_run" ADD CONSTRAINT "notion_mirror_run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "notion_mirror_run_workspace_started_idx" ON "notion_mirror_run" USING btree ("workspace_id","started_at");