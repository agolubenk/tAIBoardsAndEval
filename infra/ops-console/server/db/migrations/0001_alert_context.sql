ALTER TABLE `alerts` ADD `facts_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `alerts` ADD `hint` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `alerts` ADD `links_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `alerts` ADD `resolved_by` text;--> statement-breakpoint
ALTER TABLE `alerts` ADD `resolution` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `containers` ADD `health_log` text DEFAULT '' NOT NULL;