CREATE TABLE `agent_enrollments` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_from_ip` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agent_enrollments_agent` ON `agent_enrollments` (`agent_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `alert_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`alert_id` integer NOT NULL,
	`author` text NOT NULL,
	`message` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_alert_notes` ON `alert_notes` (`alert_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `maintenance_windows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`target` text DEFAULT '' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`starts_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`ends_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`ended_at` integer,
	`ended_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_maintenance_active` ON `maintenance_windows` (`ends_at`,`scope`);--> statement-breakpoint
ALTER TABLE `check_results` ADD `dns_ms` integer;--> statement-breakpoint
ALTER TABLE `check_results` ADD `connect_ms` integer;--> statement-breakpoint
ALTER TABLE `check_results` ADD `tls_ms` integer;--> statement-breakpoint
ALTER TABLE `check_results` ADD `ttfb_ms` integer;--> statement-breakpoint
ALTER TABLE `incidents` ADD `assignee` text;--> statement-breakpoint
ALTER TABLE `incidents` ADD `assigned_at` integer;--> statement-breakpoint
ALTER TABLE `incidents` ADD `close_result` text;--> statement-breakpoint
ALTER TABLE `incidents` ADD `close_comment` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `monitors` ADD `type` text DEFAULT 'http' NOT NULL;--> statement-breakpoint
ALTER TABLE `monitors` ADD `dns_record` text DEFAULT 'A' NOT NULL;--> statement-breakpoint
ALTER TABLE `monitors` ADD `expect_value` text;--> statement-breakpoint
ALTER TABLE `monitors` ADD `description` text DEFAULT '' NOT NULL;