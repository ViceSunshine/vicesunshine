ALTER TABLE `profiles` ADD COLUMN `bio` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `display_name` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `email` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `profile_private` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `show_clan` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `notify_reposts` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `notify_party` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `language` text DEFAULT 'en' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `currency` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `timezone` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `referral_code` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `referred_by` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `referral_discount` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `blocked_users` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `player_key` text NOT NULL,
  `blocked_key` text NOT NULL,
  `blocked_gamertag` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL
);
