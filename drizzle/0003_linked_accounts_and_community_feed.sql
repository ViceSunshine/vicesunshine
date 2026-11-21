ALTER TABLE profiles ADD COLUMN psn_id TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE profiles ADD COLUMN xbox_id TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE profiles ADD COLUMN discord_id TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE profiles ADD COLUMN other_links TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE profiles ADD COLUMN show_psn INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE profiles ADD COLUMN show_xbox INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE profiles ADD COLUMN show_discord INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE profiles ADD COLUMN show_other INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TABLE feed_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_key TEXT NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'Post',
  body TEXT NOT NULL,
  media_url TEXT NOT NULL DEFAULT '',
  shares INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE feed_reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  player_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE feed_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  author_key TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE feed_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  reporter_key TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE feed_hidden (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  player_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
