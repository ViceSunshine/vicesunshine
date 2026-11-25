DELETE FROM `crew_join_history` WHERE `clan_id` = 23;
--> statement-breakpoint
DELETE FROM `clan_members` WHERE `clan_id` = 23;
--> statement-breakpoint
DELETE FROM `clans` WHERE `id` = 23 AND `tag` = 'CR7' AND `name` = 'THE GOAT';
