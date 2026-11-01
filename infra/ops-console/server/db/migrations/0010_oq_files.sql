CREATE TABLE `oq_files` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`created_by` text NOT NULL,
	`deleted_at` integer,
	`deleted_reason` text
);
--> statement-breakpoint
CREATE INDEX `idx_oq_files_item` ON `oq_files` (`item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oq_files_item_sha` ON `oq_files` (`item_id`,`sha256`) WHERE deleted_at IS NULL;