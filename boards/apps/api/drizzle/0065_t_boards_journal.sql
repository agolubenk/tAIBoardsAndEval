CREATE TABLE "agent_journal" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"outcome" text NOT NULL,
	"detail" text,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_journal" ADD CONSTRAINT "agent_journal_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "agent_journal_workspace_created_at_idx" ON "agent_journal" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "timber_log_felled_task_ids_idx" ON "timber_log" USING gin ("felled_task_ids" jsonb_path_ops);