ALTER TABLE `profiles` ADD COLUMN `location` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `website` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE `story_highlights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`player_key` text NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `story_highlight_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`highlight_id` integer NOT NULL,
	`story_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
