CREATE TABLE `payment_methods` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `player_key` text NOT NULL,
  `brand` text DEFAULT 'Visa' NOT NULL,
  `last4` text DEFAULT '' NOT NULL,
  `exp_month` integer DEFAULT 1 NOT NULL,
  `exp_year` integer DEFAULT 2030 NOT NULL,
  `label` text DEFAULT '' NOT NULL,
  `is_default` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL
);
