ALTER TABLE profiles ADD COLUMN phone TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE profiles ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE email_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT 'verify',
  code_hash TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
