CREATE TABLE `db_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text DEFAULT 'Vehicle' NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'Unverified' NOT NULL,
	`source_name` text DEFAULT '' NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`featured` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT 0 NOT NULL
);
