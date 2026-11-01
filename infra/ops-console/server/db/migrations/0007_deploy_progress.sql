CREATE TABLE `deploy_progress` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` text NOT NULL,
	`deploy_id` text NOT NULL,
	`sha` text NOT NULL,
	`status` text NOT NULL,
	`rc` integer,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`summary_json` text NOT NULL,
	`events_json` text DEFAULT '[]' NOT NULL,
	`last_seq` integer NOT NULL,
	`last_event_ts` integer NOT NULL,
	`last_event_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_deploy_progress_key` ON `deploy_progress` (`agent_id`,`deploy_id`);--> statement-breakpoint
CREATE INDEX `idx_deploy_progress_started` ON `deploy_progress` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_deploy_progress_agent_created` ON `deploy_progress` (`agent_id`,`created_at`);