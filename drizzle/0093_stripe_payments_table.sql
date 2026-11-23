CREATE TABLE `stripe_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`player_key` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`stripe_customer_id` text DEFAULT '' NOT NULL,
	`stripe_subscription_id` text DEFAULT '' NOT NULL,
	`stripe_session_id` text DEFAULT '' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`amount_cents` integer DEFAULT 0 NOT NULL,
	`total_paid_cents` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`cancel_at_period_end` integer DEFAULT 0 NOT NULL,
	`period_start` text DEFAULT '' NOT NULL,
	`period_end` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT 0 NOT NULL
);
