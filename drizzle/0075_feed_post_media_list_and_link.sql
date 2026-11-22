ALTER TABLE `feed_posts` ADD COLUMN `media_urls` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `feed_posts` ADD COLUMN `link_url` text DEFAULT '' NOT NULL;
