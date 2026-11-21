ALTER TABLE `chat_groups` ADD COLUMN `event_id` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `chat_group_members` ADD COLUMN `muted` integer DEFAULT 0 NOT NULL;
