-- Renumbered 2026-11-01 from 0078 and made re-runnable (see 0078_t_boards_completed_at.sql).
CREATE TABLE IF NOT EXISTS "instance_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instance_setting_updated_by_user_id_fk') THEN
		ALTER TABLE "instance_setting" ADD CONSTRAINT "instance_setting_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;