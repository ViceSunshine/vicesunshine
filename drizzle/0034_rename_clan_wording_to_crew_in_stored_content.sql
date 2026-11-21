UPDATE events SET type = 'Crew Event' WHERE type IN ('Clan Event', 'Clan War');
--> statement-breakpoint
UPDATE clan_channels SET name = 'crew-feed' WHERE name = 'clan-feed';
--> statement-breakpoint
UPDATE events SET hashtags = TRIM(REPLACE(REPLACE(' ' || hashtags || ' ', ' clanmeet ', ' crewmeet '), ' clan ', ' crew ')) WHERE hashtags LIKE '%clan%';
--> statement-breakpoint
UPDATE credit_transactions SET reason = REPLACE(REPLACE(REPLACE(REPLACE(reason, 'Clans', 'Crews'), 'Clan', 'Crew'), 'clans', 'crews'), 'clan', 'crew') WHERE reason LIKE '%clan%';
--> statement-breakpoint
UPDATE rank_point_events SET reason = REPLACE(REPLACE(REPLACE(REPLACE(reason, 'Clans', 'Crews'), 'Clan', 'Crew'), 'clans', 'crews'), 'clan', 'crew'), verified_by = REPLACE(REPLACE(REPLACE(REPLACE(verified_by, 'Clans', 'Crews'), 'Clan', 'Crew'), 'clans', 'crews'), 'clan', 'crew') WHERE reason LIKE '%clan%' OR verified_by LIKE '%clan%';
--> statement-breakpoint
UPDATE clan_activity SET actor = REPLACE(REPLACE(REPLACE(REPLACE(actor, 'Clans', 'Crews'), 'Clan', 'Crew'), 'clans', 'crews'), 'clan', 'crew'), action = REPLACE(REPLACE(REPLACE(REPLACE(action, 'Clans', 'Crews'), 'Clan', 'Crew'), 'clans', 'crews'), 'clan', 'crew'), target = REPLACE(REPLACE(REPLACE(REPLACE(target, 'Clans', 'Crews'), 'Clan', 'Crew'), 'clans', 'crews'), 'clan', 'crew'), reason = REPLACE(REPLACE(REPLACE(REPLACE(reason, 'Clans', 'Crews'), 'Clan', 'Crew'), 'clans', 'crews'), 'clan', 'crew') WHERE actor LIKE '%clan%' OR action LIKE '%clan%' OR target LIKE '%clan%' OR reason LIKE '%clan%';
--> statement-breakpoint
UPDATE guides SET title = REPLACE(REPLACE(REPLACE(REPLACE(title, 'Clans', 'Crews'), 'Clan', 'Crew'), 'clans', 'crews'), 'clan', 'crew'), body = REPLACE(REPLACE(REPLACE(REPLACE(body, 'Clans', 'Crews'), 'Clan', 'Crew'), 'clans', 'crews'), 'clan', 'crew'), author = REPLACE(REPLACE(REPLACE(REPLACE(author, 'Clans', 'Crews'), 'Clan', 'Crew'), 'clans', 'crews'), 'clan', 'crew') WHERE title LIKE '%clan%' OR body LIKE '%clan%' OR author LIKE '%clan%';
--> statement-breakpoint
UPDATE support_requests SET topic = REPLACE(REPLACE(REPLACE(REPLACE(topic, 'Clans', 'Crews'), 'Clan', 'Crew'), 'clans', 'crews'), 'clan', 'crew') WHERE topic LIKE '%clan%';
