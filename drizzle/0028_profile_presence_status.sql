ALTER TABLE `profiles` ADD COLUMN `presence` text DEFAULT 'Online' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `last_seen` integer;
