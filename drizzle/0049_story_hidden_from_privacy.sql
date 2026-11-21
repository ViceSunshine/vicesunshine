CREATE TABLE `story_hidden_from` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`player_key` text NOT NULL,
	`hidden_key` text NOT NULL,
	`created_at` integer NOT NULL
);
