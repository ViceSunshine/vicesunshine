INSERT INTO credit_transactions (scope, owner_id, actor_key, amount, reason, created_at)
SELECT 'personal', p.player_key, p.player_key, 1000000 - p.credits,
       'Owner grant — 1,000,000 Vice Credits for the owner account',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM profiles p
WHERE p.id = COALESCE(
        (SELECT id FROM profiles WHERE LOWER(TRIM(email)) = 'officialvicesunshine@gmail.com' ORDER BY id ASC LIMIT 1),
        (SELECT id FROM profiles WHERE LOWER(TRIM(gamertag)) = 'officialvicesunshine' ORDER BY id ASC LIMIT 1)
      )
  AND p.credits < 1000000;
--> statement-breakpoint
UPDATE profiles
SET credits = 1000000
WHERE id = COALESCE(
        (SELECT id FROM profiles WHERE LOWER(TRIM(email)) = 'officialvicesunshine@gmail.com' ORDER BY id ASC LIMIT 1),
        (SELECT id FROM profiles WHERE LOWER(TRIM(gamertag)) = 'officialvicesunshine' ORDER BY id ASC LIMIT 1)
      )
  AND credits < 1000000;
