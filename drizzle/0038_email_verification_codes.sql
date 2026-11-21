CREATE TABLE `email_verification_codes` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `email` text NOT NULL,
  `player_key` text NOT NULL,
  `code` text NOT NULL,
  `attempts` integer NOT NULL DEFAULT 0,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL
);
