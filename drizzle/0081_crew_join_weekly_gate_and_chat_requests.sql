CREATE TABLE `crew_join_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`clan_id` integer NOT NULL,
	`player_key` text NOT NULL,
	`gamertag` text DEFAULT '' NOT NULL,
	`how` text DEFAULT 'direct' NOT NULL,
	`joined_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `crew_join_history` (`clan_id`, `player_key`, `gamertag`, `how`, `joined_at`)
SELECT `clan_id`, `player_key`, `gamertag`, 'direct', `joined_at` FROM `clan_members`;
--> statement-breakpoint
ALTER TABLE `clan_applications` ADD COLUMN `kind` text DEFAULT 'application' NOT NULL;
--> statement-breakpoint
ALTER TABLE `direct_messages` ADD COLUMN `join_request_id` integer DEFAULT 0 NOT NULL;
