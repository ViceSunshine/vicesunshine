ALTER TABLE `bugs` ADD COLUMN `source_name` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `bugs` ADD COLUMN `source_url` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `bugs` ADD COLUMN `auto` integer DEFAULT 0 NOT NULL;
