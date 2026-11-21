ALTER TABLE `profiles` ADD COLUMN `custom_avatar_blob_key` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `custom_status` text DEFAULT '' NOT NULL;
