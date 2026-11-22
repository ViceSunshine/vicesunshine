CREATE TABLE `feed_preferences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`player_key` text NOT NULL,
	`interested` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT 0 NOT NULL
);
