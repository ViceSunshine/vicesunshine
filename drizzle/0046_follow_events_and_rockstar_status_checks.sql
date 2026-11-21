CREATE TABLE `follow_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`follower_key` text NOT NULL,
	`following_key` text NOT NULL,
	`action` text DEFAULT 'follow' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rockstar_status_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`overall` text DEFAULT 'unknown' NOT NULL,
	`services_json` text DEFAULT '[]' NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
