CREATE TABLE "notebook_chunk" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"heading" text DEFAULT '' NOT NULL,
	"text" text NOT NULL,
	"embedding" "bytea",
	"embed_model" text,
	"embedded_at" timestamp,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('russian', heading || ' ' || text)) STORED NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notebook_source" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"title" text NOT NULL,
	"content_sha256" text NOT NULL,
	"chars" integer NOT NULL,
	"updated_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notebook_chunk" ADD CONSTRAINT "notebook_chunk_source_id_notebook_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."notebook_source"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "notebook_chunk" ADD CONSTRAINT "notebook_chunk_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "notebook_source" ADD CONSTRAINT "notebook_source_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "notebook_chunk_source_idx" ON "notebook_chunk" USING btree ("source_id","ordinal");--> statement-breakpoint
CREATE INDEX "notebook_chunk_pending_idx" ON "notebook_chunk" USING btree ("workspace_id") WHERE "notebook_chunk"."embedding" IS NULL;--> statement-breakpoint
CREATE INDEX "notebook_chunk_search_idx" ON "notebook_chunk" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "notebook_source_ref_idx" ON "notebook_source" USING btree ("workspace_id","kind","ref");