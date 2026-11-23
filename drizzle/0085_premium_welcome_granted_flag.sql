ALTER TABLE `profiles` ADD COLUMN `premium_welcome_granted` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `profiles` SET `premium_welcome_granted` = 1 WHERE EXISTS (SELECT 1 FROM `credit_transactions` WHERE `credit_transactions`.`scope` = 'personal' AND `credit_transactions`.`owner_id` = `profiles`.`player_key` AND `credit_transactions`.`reason` LIKE 'Premium welcome credits%');
