ALTER TABLE "task" ADD COLUMN "completed_at" timestamp;--> statement-breakpoint
-- t-boards (d-tb-card-fill: «готово» → the end date): a card gets its end
-- date when it enters a final column of its project and loses it when it
-- leaves, whichever path wrote the status. Moving between two final columns
-- keeps the first date; a write that changes neither the status nor the
-- project leaves the date alone.
CREATE OR REPLACE FUNCTION "t_boards_task_completed_at"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'UPDATE'
		AND NEW."status" IS NOT DISTINCT FROM OLD."status"
		AND NEW."project_id" IS NOT DISTINCT FROM OLD."project_id" THEN
		RETURN NEW;
	END IF;
	IF EXISTS (
		SELECT 1 FROM "column" c
		WHERE c."project_id" = NEW."project_id" AND c."slug" = NEW."status" AND c."is_final"
	) THEN
		NEW."completed_at" := COALESCE(
			CASE WHEN TG_OP = 'UPDATE' THEN OLD."completed_at" END,
			NEW."completed_at",
			now() AT TIME ZONE 'utc'
		);
	ELSE
		NEW."completed_at" := NULL;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "task_completed_at" BEFORE INSERT OR UPDATE OF "status", "project_id" ON "task" FOR EACH ROW
EXECUTE FUNCTION "t_boards_task_completed_at"();--> statement-breakpoint
-- A column that becomes final dates its cards by their last move into it,
-- the same way the backfill below does, so a final flag switched off and
-- back on by mistake gives the old dates back; a card with no such entry
-- gets now. A column that stops being final clears them.
CREATE OR REPLACE FUNCTION "t_boards_column_completed_at"() RETURNS trigger AS $$
BEGIN
	IF NEW."is_final" THEN
		UPDATE "task" t
		SET "completed_at" = COALESCE((
			SELECT a."created_at" FROM "activity" a
			WHERE a."task_id" = t."id"
				AND a."type" IN ('status_changed', 'moved')
				AND a."event_data"->>'newStatus' = NEW."slug"
			ORDER BY a."created_at" DESC
			LIMIT 1
		), now() AT TIME ZONE 'utc')
		WHERE t."project_id" = NEW."project_id" AND t."status" = NEW."slug";
	ELSE
		UPDATE "task" SET "completed_at" = NULL
		WHERE "project_id" = NEW."project_id" AND "status" = NEW."slug";
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "column_completed_at" AFTER UPDATE OF "is_final" ON "column" FOR EACH ROW
WHEN (OLD."is_final" IS DISTINCT FROM NEW."is_final")
EXECUTE FUNCTION "t_boards_column_completed_at"();--> statement-breakpoint
-- Cards already done take the time of their last move into the current
-- status from the activity log; with no such entry the date stays empty
-- rather than guessed. Only the server's own status entries count: POST
-- /activity takes any type and eventData from a client. Only completed_at
-- changes, so the revision and history triggers stay quiet.
UPDATE "task" t
SET "completed_at" = moved."at"
FROM (
	SELECT DISTINCT ON (a."task_id") a."task_id", a."created_at" AS "at"
	FROM "activity" a
	JOIN "task" k ON k."id" = a."task_id"
	WHERE a."type" IN ('status_changed', 'moved')
		AND a."event_data"->>'newStatus' = k."status"
	ORDER BY a."task_id", a."created_at" DESC
) moved
WHERE t."id" = moved."task_id"
	AND EXISTS (
		SELECT 1 FROM "column" c
		WHERE c."project_id" = t."project_id" AND c."slug" = t."status" AND c."is_final"
	);
