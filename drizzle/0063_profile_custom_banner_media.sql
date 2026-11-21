ALTER TABLE `profiles` ADD COLUMN `banner_blob_key` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `banner_media_type` text DEFAULT '' NOT NULL;
