ALTER TABLE `profiles` ADD COLUMN `rockstar_id` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `show_rockstar` integer DEFAULT 0 NOT NULL;
