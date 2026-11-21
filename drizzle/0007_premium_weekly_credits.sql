ALTER TABLE `profiles` ADD COLUMN `premium_since` integer;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `premium_weeks_granted` integer DEFAULT 0 NOT NULL;
