CREATE TABLE `direct_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sender_key` text NOT NULL,
	`recipient_key` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`seen` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dm_pins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`player_key` text NOT NULL,
	`other_key` text NOT NULL,
	`created_at` integer NOT NULL
);
