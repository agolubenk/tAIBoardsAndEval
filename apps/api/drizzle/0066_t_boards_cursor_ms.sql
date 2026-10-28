ALTER TABLE "owner_approval" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "owner_approval" ALTER COLUMN "created_at" SET DEFAULT (now() AT TIME ZONE 'utc');--> statement-breakpoint
ALTER TABLE "timber_log" ALTER COLUMN "felled_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "timber_log" ALTER COLUMN "felled_at" SET DEFAULT (now() AT TIME ZONE 'utc');