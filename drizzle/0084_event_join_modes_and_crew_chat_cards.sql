ALTER TABLE `direct_messages` ADD COLUMN `event_card_id` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `event_join_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`player_key` text NOT NULL,
	`gamertag` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'Pending' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_card_dismissals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`player_key` text NOT NULL,
	`created_at` integer NOT NULL
);
