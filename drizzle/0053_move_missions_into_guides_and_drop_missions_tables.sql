INSERT INTO guides (title, category, body, author, created_at)
SELECT
  m.name,
  'Missions',
  trim(
    (CASE WHEN m.kind <> '' THEN 'Type: ' || m.kind || char(10) || char(10) ELSE '' END) ||
    (CASE WHEN m.region <> '' THEN 'Region: ' || m.region || char(10) || char(10) ELSE '' END) ||
    (CASE WHEN m.characters <> '' THEN 'Characters: ' || m.characters || char(10) || char(10) ELSE '' END) ||
    (CASE WHEN m.walkthrough <> '' THEN 'Walkthrough' || char(10) || m.walkthrough || char(10) || char(10) ELSE '' END) ||
    (CASE WHEN m.rewards <> '' THEN 'Rewards: ' || m.rewards || char(10) || char(10) ELSE '' END) ||
    (CASE WHEN m.tips <> '' THEN 'Tips: ' || m.tips || char(10) || char(10) ELSE '' END) ||
    (CASE WHEN m.source_url <> '' THEN 'Official source: ' || m.source_url || char(10) ELSE '' END) ||
    (CASE WHEN m.guide_url <> '' THEN 'Video guide: ' || m.guide_url ELSE '' END)
  ),
  'ViceSunshine Guides',
  m.created_at
FROM missions m
WHERE NOT EXISTS (
  SELECT 1 FROM guides g WHERE g.title = m.name AND g.category = 'Missions'
);
--> statement-breakpoint
UPDATE account_saves
SET kind = 'guide',
    ref_id = (
      SELECT g.id FROM guides g
      JOIN missions m ON m.name = g.title AND g.category = 'Missions'
      WHERE m.id = account_saves.ref_id
      LIMIT 1
    )
WHERE kind = 'mission'
  AND EXISTS (
    SELECT 1 FROM guides g
    JOIN missions m ON m.name = g.title AND g.category = 'Missions'
    WHERE m.id = account_saves.ref_id
  );
--> statement-breakpoint
DELETE FROM account_saves WHERE kind = 'mission';
--> statement-breakpoint
DROP TABLE IF EXISTS mission_progress;
--> statement-breakpoint
DROP TABLE IF EXISTS missions;
