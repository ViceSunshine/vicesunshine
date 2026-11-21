ALTER TABLE `profiles` ADD COLUMN `credits` integer DEFAULT 500 NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `badge` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `banner_color` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `name_color` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `theme_accent` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `avatar_frame` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `clans` ADD COLUMN `wallet_credits` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `clans` ADD COLUMN `banner_style` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `clans` ADD COLUMN `name_color` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `eggs` ADD COLUMN `submitter_key` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE `credit_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text DEFAULT 'personal' NOT NULL,
	`owner_id` text NOT NULL,
	`actor_key` text DEFAULT '' NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rank_point_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`clan_id` integer DEFAULT 0 NOT NULL,
	`player_key` text NOT NULL,
	`gamertag` text DEFAULT '' NOT NULL,
	`points` integer DEFAULT 0 NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`source_ref` text DEFAULT '' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`season_key` text DEFAULT '' NOT NULL,
	`verified_by` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `clan_wars` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`week_key` text NOT NULL,
	`challenge` text DEFAULT '' NOT NULL,
	`challenge_action` text DEFAULT '' NOT NULL,
	`ends_at` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'Active' NOT NULL,
	`winner_clan_id` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `clan_war_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`war_id` integer NOT NULL,
	`clan_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `war_activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`war_id` integer NOT NULL,
	`clan_id` integer NOT NULL,
	`player_key` text NOT NULL,
	`action` text DEFAULT '' NOT NULL,
	`points` integer DEFAULT 0 NOT NULL,
	`source_ref` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `activity_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`reporter_key` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `owned_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_type` text DEFAULT 'personal' NOT NULL,
	`owner_id` text NOT NULL,
	`item_id` text NOT NULL,
	`equipped` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `season_winners` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_key` text NOT NULL,
	`board` text DEFAULT 'Global' NOT NULL,
	`clan_id` integer NOT NULL,
	`clan_name` text DEFAULT '' NOT NULL,
	`rank` integer DEFAULT 0 NOT NULL,
	`season_points` integer DEFAULT 0 NOT NULL,
	`credits_awarded` integer DEFAULT 0 NOT NULL,
	`emblem_awarded` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
