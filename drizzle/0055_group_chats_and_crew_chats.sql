CREATE TABLE `chat_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text DEFAULT 'group' NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`clan_id` integer,
	`owner_key` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chat_group_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer NOT NULL,
	`player_key` text NOT NULL,
	`last_read_id` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `direct_messages` ADD COLUMN `group_id` integer DEFAULT 0 NOT NULL;
