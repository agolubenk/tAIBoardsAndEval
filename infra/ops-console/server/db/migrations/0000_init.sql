CREATE TABLE `activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`actor` text DEFAULT 'system' NOT NULL,
	`route` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_activity_time` ON `activity` (`created_at`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`environment` text DEFAULT 'production' NOT NULL,
	`secret_enc` text NOT NULL,
	`secret_hint` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`report_interval_sec` integer DEFAULT 15 NOT NULL,
	`last_request_ts` integer DEFAULT 0 NOT NULL,
	`last_seen_at` integer,
	`last_sample_at` integer,
	`last_snapshot_json` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alert_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`agent_id` text,
	`metric` text,
	`op` text DEFAULT 'gt' NOT NULL,
	`threshold` real DEFAULT 0 NOT NULL,
	`for_samples` integer DEFAULT 1 NOT NULL,
	`severity` text DEFAULT 'warning' NOT NULL,
	`repeat_min` integer DEFAULT 240 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fingerprint` text NOT NULL,
	`rule_id` integer,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`object` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`value` text DEFAULT '' NOT NULL,
	`route` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'firing' NOT NULL,
	`breach_streak` integer DEFAULT 0 NOT NULL,
	`acknowledged_by` text,
	`acknowledged_at` integer,
	`silenced_until` integer,
	`incident_id` integer,
	`started_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_seen_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`resolved_at` integer,
	`last_notified_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_alerts_fp_status` ON `alerts` (`fingerprint`,`status`);--> statement-breakpoint
CREATE INDEX `idx_alerts_status_time` ON `alerts` (`status`,`started_at`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`secret_enc` text,
	`min_severity` text DEFAULT 'warning' NOT NULL,
	`digest` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_ok_at` integer,
	`last_error` text,
	`last_error_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `check_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`monitor_id` integer NOT NULL,
	`ok` integer NOT NULL,
	`status_code` integer,
	`latency_ms` integer,
	`error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_check_monitor_time` ON `check_results` (`monitor_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `check_rollups` (
	`monitor_id` integer NOT NULL,
	`grain` text NOT NULL,
	`bucket_start` integer NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`ok_count` integer DEFAULT 0 NOT NULL,
	`latency_sum` integer DEFAULT 0 NOT NULL,
	`latency_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`monitor_id`, `grain`, `bucket_start`)
);
--> statement-breakpoint
CREATE TABLE `commands` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` text NOT NULL,
	`type` text NOT NULL,
	`target` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_by` text NOT NULL,
	`requested_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`claimed_at` integer,
	`finished_at` integer,
	`output` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_commands_agent_status` ON `commands` (`agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_commands_time` ON `commands` (`requested_at`);--> statement-breakpoint
CREATE TABLE `containers` (
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`image` text DEFAULT '' NOT NULL,
	`state` text NOT NULL,
	`health` text DEFAULT 'none' NOT NULL,
	`status_text` text DEFAULT '' NOT NULL,
	`restart_count` integer DEFAULT 0 NOT NULL,
	`cpu_pct` real,
	`mem_mb` real,
	`mem_limit_mb` real,
	`started_at` integer,
	`compose_service` text DEFAULT '' NOT NULL,
	`restart_policy` text DEFAULT '' NOT NULL,
	`exit_code` integer,
	`stateful` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`agent_id`, `name`)
);
--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` integer,
	`target` text NOT NULL,
	`kind` text NOT NULL,
	`alert_id` integer,
	`ok` integer NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_deliveries_time` ON `deliveries` (`created_at`);--> statement-breakpoint
CREATE TABLE `deploys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_key` text NOT NULL,
	`workflow` text NOT NULL,
	`status` text NOT NULL,
	`conclusion` text,
	`head_sha` text DEFAULT '' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`actor` text DEFAULT '' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_deploys_run` ON `deploys` (`run_key`);--> statement-breakpoint
CREATE TABLE `incident_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`incident_id` integer NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`author` text DEFAULT 'system' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_incident_events` ON `incident_events` (`incident_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`severity` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`created_by` text DEFAULT 'system' NOT NULL,
	`started_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_incidents_status` ON `incidents` (`status`,`started_at`);--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_login_attempts_key` ON `login_attempts` (`key`,`created_at`);--> statement-breakpoint
CREATE TABLE `metric_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` text NOT NULL,
	`metric` text NOT NULL,
	`value` real NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_metric_agent_time` ON `metric_samples` (`agent_id`,`metric`,`created_at`);--> statement-breakpoint
CREATE TABLE `monitors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`method` text DEFAULT 'GET' NOT NULL,
	`expect_status` integer,
	`expect_health_json` integer DEFAULT false NOT NULL,
	`keyword` text,
	`interval_sec` integer DEFAULT 60 NOT NULL,
	`timeout_ms` integer DEFAULT 8000 NOT NULL,
	`tags` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`is_public` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`fail_streak` integer DEFAULT 0 NOT NULL,
	`last_checked_at` integer,
	`last_ok` integer,
	`last_status_code` integer,
	`last_latency_ms` integer,
	`last_error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`period` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`payload_json` text NOT NULL,
	`delivery_status` text NOT NULL,
	`delivery_error` text,
	`created_by` text DEFAULT 'system' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_reports_time` ON `reports` (`created_at`);--> statement-breakpoint
CREATE TABLE `rule_streaks` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`streak` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`ip` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tls_checks` (
	`domain` text PRIMARY KEY NOT NULL,
	`issuer` text DEFAULT '' NOT NULL,
	`valid_to` integer,
	`days_left` integer,
	`error` text,
	`checked_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`password_hash` text NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);