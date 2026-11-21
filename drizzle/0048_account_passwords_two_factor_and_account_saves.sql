ALTER TABLE `profiles` ADD COLUMN `password_hash` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `two_factor_secret` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `two_factor_enabled` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `two_factor_backup_hashes` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE `account_saves` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `player_key` text NOT NULL,
  `kind` text NOT NULL,
  `ref_id` integer NOT NULL,
  `meta` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_saves_player_kind_ref` ON `account_saves` (`player_key`, `kind`, `ref_id`);
