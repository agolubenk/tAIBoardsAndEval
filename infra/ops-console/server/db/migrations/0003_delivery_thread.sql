ALTER TABLE `deliveries` ADD `external_id` text;--> statement-breakpoint
CREATE INDEX `idx_deliveries_alert` ON `deliveries` (`alert_id`,`channel_id`);