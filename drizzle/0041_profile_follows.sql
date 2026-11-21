CREATE TABLE `profile_follows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`follower_key` text NOT NULL,
	`following_key` text NOT NULL,
	`created_at` integer NOT NULL
);
