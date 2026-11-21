CREATE TABLE `album_media` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`player_key` text NOT NULL,
	`media_url` text NOT NULL,
	`media_type` text NOT NULL,
	`created_at` integer NOT NULL
);
