CREATE TABLE `oq_docs` (
	`collection` text NOT NULL,
	`id` text NOT NULL,
	`data_json` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_by` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`collection`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_oq_docs_updated` ON `oq_docs` (`collection`,`updated_at`);--> statement-breakpoint
CREATE TABLE `oq_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`actor` text NOT NULL,
	`collection` text NOT NULL,
	`doc_id` text NOT NULL,
	`action` text NOT NULL,
	`before_json` text,
	`after_json` text
);
--> statement-breakpoint
CREATE INDEX `idx_oq_events_doc` ON `oq_events` (`collection`,`doc_id`,`at`);--> statement-breakpoint
CREATE INDEX `idx_oq_events_at` ON `oq_events` (`at`);--> statement-breakpoint
CREATE TABLE `oq_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`hash` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oq_tokens_hash` ON `oq_tokens` (`hash`);