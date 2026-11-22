CREATE TABLE `client_errors` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `player_key` text DEFAULT '' NOT NULL,
  `message` text DEFAULT '' NOT NULL,
  `stack` text DEFAULT '' NOT NULL,
  `component_stack` text DEFAULT '' NOT NULL,
  `screen` text DEFAULT '' NOT NULL,
  `user_agent` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL
);
