ALTER TABLE `direct_messages` ADD COLUMN `crew_invite_id` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `direct_messages` ADD COLUMN `crew_invite_state` text DEFAULT '' NOT NULL;
