ALTER TABLE `events` ADD COLUMN `visibility` text DEFAULT 'Public' NOT NULL;
--> statement-breakpoint
ALTER TABLE `events` ADD COLUMN `hashtags` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `events` ADD COLUMN `host_clan_name` text DEFAULT '' NOT NULL;
