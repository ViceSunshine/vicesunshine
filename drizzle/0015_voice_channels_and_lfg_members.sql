CREATE TABLE `voice_participants` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `scope` text DEFAULT 'clan' NOT NULL,
  `scope_id` integer DEFAULT 0 NOT NULL,
  `channel_key` text DEFAULT 'general' NOT NULL,
  `player_key` text NOT NULL,
  `gamertag` text DEFAULT '' NOT NULL,
  `muted` integer DEFAULT 0 NOT NULL,
  `deafened` integer DEFAULT 0 NOT NULL,
  `speaking` integer DEFAULT 0 NOT NULL,
  `force_muted` integer DEFAULT 0 NOT NULL,
  `last_seen` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `voice_signals` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `from_key` text NOT NULL,
  `to_key` text NOT NULL,
  `kind` text DEFAULT 'offer' NOT NULL,
  `payload` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `voice_reports` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `scope` text DEFAULT 'clan' NOT NULL,
  `scope_id` integer DEFAULT 0 NOT NULL,
  `reporter_key` text NOT NULL,
  `target_key` text DEFAULT '' NOT NULL,
  `target_gamertag` text DEFAULT '' NOT NULL,
  `reason` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lfg_members` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `lfg_id` integer NOT NULL,
  `player_key` text NOT NULL,
  `gamertag` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL
);
