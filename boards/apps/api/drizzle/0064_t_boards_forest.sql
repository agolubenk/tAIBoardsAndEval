CREATE TABLE "felling" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"sector_id" text,
	"approval_id" text,
	"reason" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"tree_count" integer NOT NULL,
	"task_count" integer NOT NULL,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owner_approval" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"params_hash" text NOT NULL,
	"reason" text,
	"requested_by_kind" text NOT NULL,
	"requested_by_id" text NOT NULL,
	"requested_by_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" text,
	"decided_via" text,
	"decided_at" timestamp,
	"consumed_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sector" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"detected_by" text NOT NULL,
	"signature" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"felling_id" text,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sector_tree" (
	"sector_id" text NOT NULL,
	"task_id" text NOT NULL,
	CONSTRAINT "sector_tree_sector_id_task_id_pk" PRIMARY KEY("sector_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "seed" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"log_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"source_task_ids" jsonb NOT NULL,
	"source_project_ids" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"compressor" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_lease" (
	"task_id" text PRIMARY KEY NOT NULL,
	"holder_id" text NOT NULL,
	"holder_name" text NOT NULL,
	"holder_kind" text NOT NULL,
	"group_key" text,
	"fencing_token" integer DEFAULT 1 NOT NULL,
	"acquired_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timber_log" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"felling_id" text NOT NULL,
	"source_project_id" text NOT NULL,
	"source_project_name" text NOT NULL,
	"source_task_id" text NOT NULL,
	"task_number" integer,
	"title" text NOT NULL,
	"final_status" text NOT NULL,
	"priority" text NOT NULL,
	"description" text,
	"fields" jsonb NOT NULL,
	"history" jsonb NOT NULL,
	"felled_task_ids" jsonb NOT NULL,
	"search_text" text NOT NULL,
	"felled_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tree_origin" (
	"task_id" text PRIMARY KEY NOT NULL,
	"seed_id" text NOT NULL,
	"log_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "felling" ADD CONSTRAINT "felling_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "felling" ADD CONSTRAINT "felling_approval_id_owner_approval_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."owner_approval"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "owner_approval" ADD CONSTRAINT "owner_approval_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "owner_approval" ADD CONSTRAINT "owner_approval_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sector" ADD CONSTRAINT "sector_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sector_tree" ADD CONSTRAINT "sector_tree_sector_id_sector_id_fk" FOREIGN KEY ("sector_id") REFERENCES "public"."sector"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sector_tree" ADD CONSTRAINT "sector_tree_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "seed" ADD CONSTRAINT "seed_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "seed" ADD CONSTRAINT "seed_log_id_timber_log_id_fk" FOREIGN KEY ("log_id") REFERENCES "public"."timber_log"("id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "task_lease" ADD CONSTRAINT "task_lease_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timber_log" ADD CONSTRAINT "timber_log_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timber_log" ADD CONSTRAINT "timber_log_felling_id_felling_id_fk" FOREIGN KEY ("felling_id") REFERENCES "public"."felling"("id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tree_origin" ADD CONSTRAINT "tree_origin_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tree_origin" ADD CONSTRAINT "tree_origin_seed_id_seed_id_fk" FOREIGN KEY ("seed_id") REFERENCES "public"."seed"("id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tree_origin" ADD CONSTRAINT "tree_origin_log_id_timber_log_id_fk" FOREIGN KEY ("log_id") REFERENCES "public"."timber_log"("id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "felling_workspace_id_idx" ON "felling" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "owner_approval_workspace_status_idx" ON "owner_approval" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "owner_approval_target_idx" ON "owner_approval" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "sector_workspace_status_idx" ON "sector" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sector_workspace_active_signature_unique" ON "sector" USING btree ("workspace_id","signature") WHERE "sector"."status" = 'active';--> statement-breakpoint
CREATE INDEX "sector_tree_task_id_idx" ON "sector_tree" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "seed_log_id_idx" ON "seed" USING btree ("log_id");--> statement-breakpoint
CREATE INDEX "seed_workspace_id_idx" ON "seed" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "task_lease_expires_at_idx" ON "task_lease" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "timber_log_workspace_felled_at_idx" ON "timber_log" USING btree ("workspace_id","felled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "timber_log_source_task_id_unique" ON "timber_log" USING btree ("source_task_id");--> statement-breakpoint
-- t-boards (spec R-026): every content change bumps task.revision, whichever
-- path wrote it, so a fenced agent write can compare the revision it read.
-- Board moves (position, number, updated_at) do not count as content.
CREATE OR REPLACE FUNCTION "t_boards_bump_task_revision"() RETURNS trigger AS $$
BEGIN
	NEW."revision" := OLD."revision" + 1;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "task_revision" BEFORE UPDATE ON "task" FOR EACH ROW
WHEN (
	OLD."title" IS DISTINCT FROM NEW."title"
	OR OLD."description" IS DISTINCT FROM NEW."description"
	OR OLD."status" IS DISTINCT FROM NEW."status"
	OR OLD."column_id" IS DISTINCT FROM NEW."column_id"
	OR OLD."priority" IS DISTINCT FROM NEW."priority"
	OR OLD."assignee_id" IS DISTINCT FROM NEW."assignee_id"
	OR OLD."start_date" IS DISTINCT FROM NEW."start_date"
	OR OLD."due_date" IS DISTINCT FROM NEW."due_date"
	OR OLD."project_id" IS DISTINCT FROM NEW."project_id"
)
EXECUTE FUNCTION "t_boards_bump_task_revision"();
