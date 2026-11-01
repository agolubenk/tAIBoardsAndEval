CREATE TABLE "card_meta" (
	"task_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text DEFAULT 'task' NOT NULL,
	"severity" text,
	"backlog_id" text,
	"half_baked" boolean DEFAULT false NOT NULL,
	"report" text,
	"notion_page_id" text,
	"notion_status" text,
	"executor" text,
	"branch" text,
	"pull_requests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tokens" integer,
	"cost_usd" numeric(12, 4),
	"context_pack" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "card_meta" ADD CONSTRAINT "card_meta_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "card_meta" ADD CONSTRAINT "card_meta_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "card_meta_workspace_backlog_id_idx" ON "card_meta" USING btree ("workspace_id","backlog_id");--> statement-breakpoint
CREATE UNIQUE INDEX "card_meta_notion_page_id_idx" ON "card_meta" USING btree ("notion_page_id");--> statement-breakpoint
CREATE INDEX "card_meta_workspace_kind_idx" ON "card_meta" USING btree ("workspace_id","kind");