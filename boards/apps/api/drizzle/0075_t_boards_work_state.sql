CREATE TABLE "session_work_state" (
	"workspace_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"actor_kind" text NOT NULL,
	"task_id" text,
	"step" text NOT NULL,
	"branch" text,
	"waiting" text,
	"updated_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	CONSTRAINT "session_work_state_workspace_id_actor_id_pk" PRIMARY KEY("workspace_id","actor_id")
);
--> statement-breakpoint
ALTER TABLE "session_work_state" ADD CONSTRAINT "session_work_state_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "session_work_state" ADD CONSTRAINT "session_work_state_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "session_work_state_updated_at_idx" ON "session_work_state" USING btree ("workspace_id","updated_at");