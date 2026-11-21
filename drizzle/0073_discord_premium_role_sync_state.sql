CREATE TABLE `discord_role_sync` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`player_key` text NOT NULL,
	`discord_id` text DEFAULT '' NOT NULL,
	`desired` text DEFAULT 'remove' NOT NULL,
	`bot_status` text DEFAULT 'pending' NOT NULL,
	`bot_note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
