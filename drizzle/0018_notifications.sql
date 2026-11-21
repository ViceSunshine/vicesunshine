CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`player_key` text NOT NULL,
	`actor_gamertag` text NOT NULL,
	`kind` text DEFAULT 'Repost' NOT NULL,
	`post_id` integer DEFAULT 0 NOT NULL,
	`repost_post_id` integer DEFAULT 0 NOT NULL,
	`post_title` text DEFAULT '' NOT NULL,
	`read` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
