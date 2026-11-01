CREATE TABLE `agent_vpn` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`endpoints_json` text DEFAULT '[]' NOT NULL,
	`destinations_json` text DEFAULT '{}' NOT NULL,
	`captured_at` integer,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
