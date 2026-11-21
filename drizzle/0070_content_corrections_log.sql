CREATE TABLE `content_corrections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target_type` text NOT NULL DEFAULT '',
	`target_label` text NOT NULL DEFAULT '',
	`field` text NOT NULL DEFAULT '',
	`old_value` text NOT NULL DEFAULT '',
	`new_value` text NOT NULL DEFAULT '',
	`source_name` text NOT NULL DEFAULT '',
	`source_url` text NOT NULL DEFAULT '',
	`created_at` integer NOT NULL
);
