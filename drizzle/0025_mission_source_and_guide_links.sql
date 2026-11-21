ALTER TABLE `missions` ADD COLUMN `source_url` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `missions` ADD COLUMN `guide_url` text DEFAULT '' NOT NULL;
