CREATE TABLE `bug_votes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bug_id` integer NOT NULL,
	`player_key` text NOT NULL,
	`created_at` integer NOT NULL
);
