ALTER TABLE `db_entries` ADD COLUMN `type` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `db_entries` ADD COLUMN `manufacturer` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE `db_ratings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_id` integer NOT NULL,
	`player_key` text NOT NULL,
	`rating` integer DEFAULT 5 NOT NULL,
	`created_at` integer DEFAULT 0 NOT NULL
);
