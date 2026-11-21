ALTER TABLE `profiles` ADD COLUMN `private_note` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `wishlist` text DEFAULT '' NOT NULL;
