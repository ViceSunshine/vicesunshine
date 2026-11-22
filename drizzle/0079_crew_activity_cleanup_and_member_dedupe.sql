DELETE FROM `clan_activity` WHERE `action` LIKE 'earned a Crew Award%';
--> statement-breakpoint
DELETE FROM `clan_members` WHERE `id` NOT IN (SELECT MIN(`id`) FROM `clan_members` GROUP BY `clan_id`, `player_key`);
--> statement-breakpoint
DELETE FROM `chat_group_members` WHERE `id` NOT IN (SELECT MIN(`id`) FROM `chat_group_members` GROUP BY `group_id`, `player_key`);
--> statement-breakpoint
DELETE FROM `clan_activity` WHERE `action` = 'joined as Recruit' AND EXISTS (
	SELECT 1 FROM `clan_activity` prev
	WHERE prev.`clan_id` = `clan_activity`.`clan_id`
		AND prev.`actor` = `clan_activity`.`actor`
		AND prev.`action` = 'joined as Recruit'
		AND prev.`id` < `clan_activity`.`id`
		AND NOT EXISTS (
			SELECT 1 FROM `clan_activity` mid
			WHERE mid.`clan_id` = `clan_activity`.`clan_id`
				AND mid.`id` > prev.`id` AND mid.`id` < `clan_activity`.`id`
				AND ((mid.`actor` = `clan_activity`.`actor` AND mid.`action` LIKE 'left the crew%')
					OR (mid.`target` = `clan_activity`.`actor` AND mid.`action` = 'kicked'))
		)
);
