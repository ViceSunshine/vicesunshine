CREATE TABLE `dm_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`reporter_key` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`details` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT 0 NOT NULL
);
