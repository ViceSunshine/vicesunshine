ALTER TABLE `story_highlights` ADD COLUMN `cover_story_id` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `story_highlights` ADD COLUMN `cover_blob_key` text DEFAULT '' NOT NULL;
