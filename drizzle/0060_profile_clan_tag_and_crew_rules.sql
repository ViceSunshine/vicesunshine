ALTER TABLE profiles ADD COLUMN clan_tag text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE clans ADD COLUMN rules text DEFAULT '' NOT NULL;
