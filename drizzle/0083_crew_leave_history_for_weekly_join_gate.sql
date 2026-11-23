CREATE TABLE `crew_leave_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`clan_id` integer NOT NULL,
	`player_key` text NOT NULL,
	`gamertag` text DEFAULT '' NOT NULL,
	`left_at` integer NOT NULL
);
