ALTER TABLE `events` ADD COLUMN `lobby_details` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `events` ADD COLUMN `lobby_link` text DEFAULT '' NOT NULL;
