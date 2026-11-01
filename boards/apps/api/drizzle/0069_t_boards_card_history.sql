CREATE TABLE "card_history" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"task_id" text NOT NULL,
	"kind" text NOT NULL,
	"revision" integer,
	"changes" jsonb NOT NULL,
	"actor_id" text,
	"created_at" timestamp DEFAULT (clock_timestamp() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "card_history" ADD CONSTRAINT "card_history_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "card_history_task_created_at_idx" ON "card_history" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "card_history_actor_idx" ON "card_history" USING btree ("actor_id");--> statement-breakpoint
-- R-023: the fields a card's history compares, under the names the API uses.
-- Dates go out as UTC ISO strings with milliseconds, the precision JS keeps
-- (kaneo stores UTC in timestamp columns).
CREATE OR REPLACE FUNCTION "t_boards_iso"(value timestamp) RETURNS text AS $$
	SELECT to_char(value, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$ LANGUAGE sql IMMUTABLE;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "t_boards_task_fields"(t "task") RETURNS jsonb AS $$
	SELECT jsonb_build_object(
		'title', t."title",
		'description', t."description",
		'status', t."status",
		'columnId', t."column_id",
		'priority', t."priority",
		'assigneeId', t."assignee_id",
		'startDate', "t_boards_iso"(t."start_date"),
		'dueDate', "t_boards_iso"(t."due_date"),
		'projectId', t."project_id"
	);
$$ LANGUAGE sql STABLE;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "t_boards_card_meta_fields"(m "card_meta") RETURNS jsonb AS $$
	SELECT jsonb_build_object(
		'kind', m."kind",
		'severity', m."severity",
		'backlogId', m."backlog_id",
		'halfBaked', m."half_baked",
		'report', m."report",
		'notionPageId', m."notion_page_id",
		'notionStatus', m."notion_status",
		'executor', m."executor",
		'branch', m."branch",
		'pullRequests', m."pull_requests",
		'files', m."files",
		'tokens', m."tokens",
		'costUsd', m."cost_usd",
		'contextPack', m."context_pack"
	);
$$ LANGUAGE sql STABLE;--> statement-breakpoint
-- {field: {from, to}} for the keys whose value differs.
CREATE OR REPLACE FUNCTION "t_boards_diff"(a jsonb, b jsonb) RETURNS jsonb AS $$
	SELECT coalesce(
		jsonb_object_agg(key, jsonb_build_object('from', a -> key, 'to', b -> key)),
		'{}'::jsonb
	)
	FROM jsonb_object_keys(b) AS key
	WHERE a -> key IS DISTINCT FROM b -> key;
$$ LANGUAGE sql IMMUTABLE;--> statement-breakpoint
-- The actor comes from the transaction (t-boards' own writes set it); kaneo's
-- routes leave it empty and the agent guard fills it in afterwards.
CREATE OR REPLACE FUNCTION "t_boards_task_history"() RETURNS trigger AS $$
DECLARE
	changed jsonb := "t_boards_diff"("t_boards_task_fields"(OLD), "t_boards_task_fields"(NEW));
BEGIN
	IF changed <> '{}'::jsonb THEN
		INSERT INTO "card_history" ("task_id", "kind", "revision", "changes", "actor_id")
		VALUES (NEW."id", 'task', OLD."revision", changed, NULLIF(current_setting('t_boards.actor', true), ''));
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "task_history" AFTER UPDATE ON "task" FOR EACH ROW
WHEN (OLD."revision" IS DISTINCT FROM NEW."revision")
EXECUTE FUNCTION "t_boards_task_history"();--> statement-breakpoint
-- A card without a card_meta row has the defaults, so the first write is
-- compared with them.
CREATE OR REPLACE FUNCTION "t_boards_card_meta_history"() RETURNS trigger AS $$
DECLARE
	changed jsonb := "t_boards_diff"(
		CASE WHEN TG_OP = 'UPDATE' THEN "t_boards_card_meta_fields"(OLD)
		ELSE '{"kind":"task","severity":null,"backlogId":null,"halfBaked":false,"report":null,"notionPageId":null,"notionStatus":null,"executor":null,"branch":null,"pullRequests":[],"files":[],"tokens":null,"costUsd":null,"contextPack":null}'::jsonb
		END,
		"t_boards_card_meta_fields"(NEW)
	);
BEGIN
	IF changed <> '{}'::jsonb THEN
		INSERT INTO "card_history" ("task_id", "kind", "changes", "actor_id")
		VALUES (NEW."task_id", 'meta', changed, NEW."updated_by");
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "card_meta_history" AFTER INSERT OR UPDATE ON "card_meta" FOR EACH ROW
EXECUTE FUNCTION "t_boards_card_meta_history"();
