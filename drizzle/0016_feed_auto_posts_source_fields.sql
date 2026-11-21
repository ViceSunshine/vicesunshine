ALTER TABLE `feed_posts` ADD COLUMN `auto` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `feed_posts` ADD COLUMN `source_name` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `feed_posts` ADD COLUMN `source_url` text DEFAULT '' NOT NULL;
