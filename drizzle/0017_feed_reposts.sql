ALTER TABLE `feed_posts` ADD COLUMN `repost_of_id` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `feed_reposts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`player_key` text NOT NULL,
	`repost_post_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
