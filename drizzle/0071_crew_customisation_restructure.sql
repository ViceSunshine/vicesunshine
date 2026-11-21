ALTER TABLE `clans` ADD COLUMN `badge` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `clans` ADD COLUMN `theme_accent` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `clans` ADD COLUMN `requirements` text DEFAULT '' NOT NULL;
--> statement-breakpoint
DELETE FROM `owned_items` WHERE `item_id` IN (
  'avatar-street', 'avatar-crew', 'avatar-driver', 'avatar-surfer', 'avatar-racer',
  'avatar-neon-outlaw', 'avatar-alien-visitor', 'avatar-supercar-ace',
  'effect-ember-glow', 'effect-frost-ring', 'effect-shadow-veil', 'effect-neon-pulse',
  'effect-sunset-haze', 'effect-fire', 'effect-lightning', 'effect-neon-surge',
  'badge-rookie', 'badge-crew', 'badge-season', 'badge-season-champion', 'badge-vice-legend',
  'badge-premium', 'badge-vice-elite', 'badge-neon-legend',
  'card-vice-nights', 'card-street-heat', 'card-palm-reaper', 'card-keys-runner', 'card-skull-strip',
  'card-leonida-haze', 'card-armed-palms', 'card-club-leonida',
  'theme-vice-pink', 'theme-neon-teal', 'theme-neon-purple', 'theme-sunset-amber', 'theme-sunset-orange',
  'theme-gold-vice', 'theme-ice-vice', 'theme-ultraviolet-vice'
) AND `owner_type` = 'personal';
--> statement-breakpoint
UPDATE `profiles` SET `avatar_id` = '', `avatar_effect` = '', `badge` = '', `calling_card` = '', `theme_accent` = '';
