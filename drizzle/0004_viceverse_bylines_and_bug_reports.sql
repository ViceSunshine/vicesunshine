UPDATE news SET source_name = 'ViceVerse editors' WHERE source_name = 'Leonida Hub editors';
--> statement-breakpoint
UPDATE guides SET author = 'ViceVerse editors' WHERE author = 'Leonida Hub editors';
--> statement-breakpoint
ALTER TABLE bugs ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE bug_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bug_id INTEGER NOT NULL,
  reporter_key TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
