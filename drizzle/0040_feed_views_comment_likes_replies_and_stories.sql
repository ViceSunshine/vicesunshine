ALTER TABLE `feed_comments` ADD COLUMN `parent_id` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `feed_comment_reactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`comment_id` integer NOT NULL,
	`player_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `feed_views` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`player_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`author_key` text NOT NULL,
	`author` text NOT NULL,
	`media_url` text DEFAULT '' NOT NULL,
	`media_type` text DEFAULT 'text' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`sticker` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `story_views` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`player_key` text NOT NULL,
	`viewer_gamertag` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `story_likes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`player_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `story_replies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`player_key` text NOT NULL,
	`author` text DEFAULT '' NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL
);
