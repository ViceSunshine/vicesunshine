UPDATE feed_posts SET author = REPLACE(author, 'ViceVerse', 'ViceSunshine') WHERE author LIKE '%ViceVerse%';
--> statement-breakpoint
UPDATE feed_posts SET title = REPLACE(title, 'ViceVerse', 'ViceSunshine'), body = REPLACE(body, 'ViceVerse', 'ViceSunshine') WHERE auto = 1 AND (title LIKE '%ViceVerse%' OR body LIKE '%ViceVerse%');
--> statement-breakpoint
UPDATE events SET host = REPLACE(host, 'ViceVerse', 'ViceSunshine') WHERE host LIKE '%ViceVerse%';
--> statement-breakpoint
UPDATE rank_point_events SET verified_by = REPLACE(verified_by, 'ViceVerse', 'ViceSunshine'), reason = REPLACE(reason, 'ViceVerse', 'ViceSunshine') WHERE verified_by LIKE '%ViceVerse%' OR reason LIKE '%ViceVerse%';
--> statement-breakpoint
UPDATE credit_transactions SET reason = REPLACE(reason, 'ViceVerse', 'ViceSunshine') WHERE reason LIKE '%ViceVerse%';
--> statement-breakpoint
UPDATE clan_activity SET actor = REPLACE(actor, 'ViceVerse', 'ViceSunshine'), action = REPLACE(action, 'ViceVerse', 'ViceSunshine'), target = REPLACE(target, 'ViceVerse', 'ViceSunshine'), reason = REPLACE(reason, 'ViceVerse', 'ViceSunshine') WHERE actor LIKE '%ViceVerse%' OR action LIKE '%ViceVerse%' OR target LIKE '%ViceVerse%' OR reason LIKE '%ViceVerse%';
--> statement-breakpoint
UPDATE news SET title = REPLACE(title, 'ViceVerse', 'ViceSunshine'), summary = REPLACE(summary, 'ViceVerse', 'ViceSunshine'), source_name = REPLACE(source_name, 'ViceVerse', 'ViceSunshine') WHERE title LIKE '%ViceVerse%' OR summary LIKE '%ViceVerse%' OR source_name LIKE '%ViceVerse%';
--> statement-breakpoint
UPDATE guides SET title = REPLACE(title, 'ViceVerse', 'ViceSunshine'), body = REPLACE(body, 'ViceVerse', 'ViceSunshine'), author = REPLACE(author, 'ViceVerse', 'ViceSunshine') WHERE title LIKE '%ViceVerse%' OR body LIKE '%ViceVerse%' OR author LIKE '%ViceVerse%';
--> statement-breakpoint
UPDATE notifications SET actor_gamertag = REPLACE(actor_gamertag, 'ViceVerse', 'ViceSunshine'), post_title = REPLACE(post_title, 'ViceVerse', 'ViceSunshine') WHERE actor_gamertag LIKE '%ViceVerse%' OR post_title LIKE '%ViceVerse%';
