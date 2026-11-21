ALTER TABLE `eggs` ADD COLUMN `source_name` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `eggs` ADD COLUMN `source_url` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE `egg_media` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`egg_id` integer NOT NULL,
	`kind` text DEFAULT 'Video' NOT NULL,
	`title` text NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`source_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
