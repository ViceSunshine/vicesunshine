CREATE TABLE `search_terms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`term_key` text NOT NULL,
	`term` text DEFAULT '' NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_terms_term_key_unique` ON `search_terms` (`term_key`);
