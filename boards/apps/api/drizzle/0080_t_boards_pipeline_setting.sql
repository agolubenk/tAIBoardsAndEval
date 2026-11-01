-- Per-workspace (product) switches of the automated team process; re-runnable like 0078/0079.
CREATE TABLE IF NOT EXISTS "workspace_pipeline_setting" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_pipeline_setting_workspace_id_workspace_id_fk') THEN
		ALTER TABLE "workspace_pipeline_setting" ADD CONSTRAINT "workspace_pipeline_setting_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_pipeline_setting_updated_by_user_id_fk') THEN
		ALTER TABLE "workspace_pipeline_setting" ADD CONSTRAINT "workspace_pipeline_setting_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
