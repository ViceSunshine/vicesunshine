CREATE TABLE IF NOT EXISTS `ui_translations` (
	`language` text PRIMARY KEY NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL
);
