CREATE TABLE `follow_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`requester_key` text NOT NULL,
	`following_key` text NOT NULL,
	`created_at` integer NOT NULL
);
