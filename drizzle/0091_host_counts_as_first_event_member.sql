INSERT INTO `rsvps` (`event_id`, `player_key`, `gamertag`, `status`, `created_at`)
SELECT e.`id`, p.`player_key`, p.`gamertag`, 'Going', e.`created_at`
FROM `events` e
JOIN `profiles` p ON p.`id` = (
  SELECT MIN(p2.`id`) FROM `profiles` p2 WHERE lower(p2.`gamertag`) = lower(e.`host`)
)
WHERE NOT EXISTS (
  SELECT 1 FROM `rsvps` r WHERE r.`event_id` = e.`id` AND r.`player_key` = p.`player_key`
);
