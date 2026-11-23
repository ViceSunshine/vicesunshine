CREATE TABLE IF NOT EXISTS `event_free_passes` (
  `player_key` text PRIMARY KEY NOT NULL,
  `last_used_at` integer NOT NULL,
  `last_title` text DEFAULT '' NOT NULL,
  `last_clan_id` integer
);
