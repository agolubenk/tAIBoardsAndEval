CREATE TABLE `tg_bot` (
	`id` integer PRIMARY KEY NOT NULL,
	`bot_token_enc` text NOT NULL,
	`bot_id` text NOT NULL,
	`bot_username` text DEFAULT '' NOT NULL,
	`webhook_secret_enc` text,
	`webhook_url` text DEFAULT '' NOT NULL,
	`password_hash` text DEFAULT '' NOT NULL,
	`password_version` integer DEFAULT 0 NOT NULL,
	`password_changed_at` integer,
	`password_changed_by` text,
	`frozen_reason` text,
	`frozen_at` integer,
	`poll_offset` integer DEFAULT 0 NOT NULL,
	`last_check_at` integer,
	`last_error` text,
	`pending_updates` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tg_chats` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`added_by` text,
	`seen_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tg_link_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`tg_user_id` text,
	`chat_id` text,
	`username` text,
	`display_name` text,
	`code_hash` text,
	`code_expires_at` integer,
	`code_attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tg_link_user` ON `tg_link_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `tg_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`bot_id` text NOT NULL,
	`tg_user_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`username` text DEFAULT '' NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`state` text DEFAULT 'awaiting_password' NOT NULL,
	`confirmed_version` integer DEFAULT 0 NOT NULL,
	`prompted_version` integer DEFAULT 0 NOT NULL,
	`min_severity` text DEFAULT 'warning' NOT NULL,
	`digest` integer DEFAULT false NOT NULL,
	`linked_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`activated_at` integer,
	`suspended_at` integer,
	`suspended_reason` text,
	`suspended_by` text,
	`owner_lock` integer DEFAULT false NOT NULL,
	`last_delivery_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tg_sub_user` ON `tg_subscriptions` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tg_sub_tg_user` ON `tg_subscriptions` (`tg_user_id`);--> statement-breakpoint
CREATE TABLE `tg_updates` (
	`bot_id` text NOT NULL,
	`update_id` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`bot_id`, `update_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_tg_updates_time` ON `tg_updates` (`created_at`);--> statement-breakpoint
ALTER TABLE `deliveries` ADD `subscription_id` integer;--> statement-breakpoint
CREATE INDEX `idx_deliveries_alert_sub` ON `deliveries` (`alert_id`,`subscription_id`);