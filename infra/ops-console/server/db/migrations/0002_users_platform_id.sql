ALTER TABLE `users` ADD `platform_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `sso_checked_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_platform_id` ON `users` (`platform_id`);