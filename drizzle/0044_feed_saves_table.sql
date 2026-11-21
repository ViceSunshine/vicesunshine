CREATE TABLE `feed_saves` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`player_key` text NOT NULL,
	`created_at` integer NOT NULL
);
