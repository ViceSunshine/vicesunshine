ALTER TABLE `profiles` ADD COLUMN `username_changes` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `last_username_change_at` integer;
