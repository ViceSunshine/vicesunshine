CREATE TABLE IF NOT EXISTS `player_reports` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `reporter_key` text NOT NULL,
  `reported_key` text NOT NULL,
  `reason` text NOT NULL DEFAULT '',
  `details` text NOT NULL DEFAULT '',
  `created_at` integer NOT NULL DEFAULT 0
);
