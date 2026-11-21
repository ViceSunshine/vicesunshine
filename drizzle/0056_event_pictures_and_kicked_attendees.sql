ALTER TABLE `events` ADD COLUMN `image_blob_key` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE `event_kicked` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`player_key` text NOT NULL,
	`gamertag` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
