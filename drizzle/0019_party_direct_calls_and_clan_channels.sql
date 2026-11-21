CREATE TABLE `clan_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`clan_id` integer NOT NULL,
	`kind` text DEFAULT 'voice' NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`visibility` text DEFAULT 'public' NOT NULL,
	`allowed_roles` text DEFAULT '' NOT NULL,
	`allowed_keys` text DEFAULT '' NOT NULL,
	`member_limit` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `party_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`host_key` text NOT NULL,
	`host_gamertag` text DEFAULT '' NOT NULL,
	`invite_code` text NOT NULL,
	`max_members` integer DEFAULT 20 NOT NULL,
	`visibility` text DEFAULT 'public' NOT NULL,
	`ended` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `party_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`party_id` integer NOT NULL,
	`player_key` text NOT NULL,
	`gamertag` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'Member' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `clans` ADD COLUMN `elders_manage_channels` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `voice_participants` ADD COLUMN `force_deafened` integer DEFAULT 0 NOT NULL;
