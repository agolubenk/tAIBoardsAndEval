ALTER TABLE `containers` ADD `compose_project` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `containers` ADD `restartable` integer;--> statement-breakpoint
ALTER TABLE `containers` ADD `main_stack` integer DEFAULT true NOT NULL;