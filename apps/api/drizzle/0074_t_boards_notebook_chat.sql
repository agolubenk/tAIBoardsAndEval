CREATE TABLE "notebook_message" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"status" text,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"created_by" text,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notebook_thread" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	"updated_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notebook_message" ADD CONSTRAINT "notebook_message_thread_id_notebook_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."notebook_thread"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "notebook_message" ADD CONSTRAINT "notebook_message_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "notebook_message" ADD CONSTRAINT "notebook_message_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "notebook_thread" ADD CONSTRAINT "notebook_thread_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "notebook_thread" ADD CONSTRAINT "notebook_thread_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "notebook_message_thread_idx" ON "notebook_message" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "notebook_message_model_idx" ON "notebook_message" USING btree ("created_at") WHERE "notebook_message"."model" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notebook_thread_workspace_idx" ON "notebook_thread" USING btree ("workspace_id","updated_at");