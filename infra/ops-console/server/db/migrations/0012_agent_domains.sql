CREATE TABLE `agent_domains` (
	`agent_id` text NOT NULL,
	`domain` text NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`port` integer,
	`tls` integer DEFAULT false NOT NULL,
	`issuer` text DEFAULT '' NOT NULL,
	`valid_to` integer,
	`error` text,
	`checked_at` integer,
	`stale` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`agent_id`, `domain`)
);
