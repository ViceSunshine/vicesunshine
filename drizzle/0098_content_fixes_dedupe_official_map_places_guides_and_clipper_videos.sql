DELETE FROM `bug_votes` WHERE `bug_id` IN (2, 10, 23, 35, 37, 39, 47, 51, 62, 4, 17, 40, 45, 49, 55, 61, 63, 50, 56, 59, 33, 53);
--> statement-breakpoint
DELETE FROM `bug_reports` WHERE `bug_id` IN (2, 10, 23, 35, 37, 39, 47, 51, 62, 4, 17, 40, 45, 49, 55, 61, 63, 50, 56, 59, 33, 53);
--> statement-breakpoint
DELETE FROM `bugs` WHERE `id` IN (2, 10, 23, 35, 37, 39, 47, 51, 62);
--> statement-breakpoint
DELETE FROM `bugs` WHERE `id` IN (4, 17, 40, 45, 49, 55, 61, 63);
--> statement-breakpoint
DELETE FROM `bugs` WHERE `id` IN (50, 56, 59);
--> statement-breakpoint
DELETE FROM `bugs` WHERE `id` IN (33, 53);
--> statement-breakpoint
DELETE FROM `feed_comment_reactions` WHERE `comment_id` IN (SELECT `id` FROM `feed_comments` WHERE `post_id` IN (898, 899));
--> statement-breakpoint
DELETE FROM `feed_comments` WHERE `post_id` IN (898, 899);
--> statement-breakpoint
DELETE FROM `feed_reactions` WHERE `post_id` IN (898, 899);
--> statement-breakpoint
DELETE FROM `feed_reports` WHERE `post_id` IN (898, 899);
--> statement-breakpoint
DELETE FROM `feed_reposts` WHERE `post_id` IN (898, 899) OR `repost_post_id` IN (898, 899);
--> statement-breakpoint
DELETE FROM `feed_views` WHERE `post_id` IN (898, 899);
--> statement-breakpoint
DELETE FROM `feed_saves` WHERE `post_id` IN (898, 899);
--> statement-breakpoint
DELETE FROM `feed_hidden` WHERE `post_id` IN (898, 899);
--> statement-breakpoint
DELETE FROM `feed_preferences` WHERE `post_id` IN (898, 899);
--> statement-breakpoint
DELETE FROM `notifications` WHERE `post_id` IN (898, 899);
--> statement-breakpoint
DELETE FROM `feed_posts` WHERE `repost_of_id` IN (898, 899);
--> statement-breakpoint
DELETE FROM `feed_posts` WHERE `id` IN (898, 899);
--> statement-breakpoint
DELETE FROM `news` WHERE `id` = 119 AND `title` = 'Untitled';
--> statement-breakpoint
DELETE FROM `egg_media` WHERE `egg_id` = 15;
--> statement-breakpoint
DELETE FROM `eggs` WHERE `id` = 15 AND `name` = 'Secret cutscene atop communications tower';
--> statement-breakpoint
UPDATE `eggs` SET `how_to` = 'A literal painted Easter egg sits in a nest on top of Vice City''s tallest tower, after about a 6–7 minute climb, and throwing it triggers a short cutscene. Player xGarbett found the secret cutscene at the top after an estimated seven-minute climb up the communications tower.' WHERE `id` = 6;
--> statement-breakpoint
DELETE FROM `crew_join_history` WHERE `clan_id` = 22;
--> statement-breakpoint
DELETE FROM `clan_members` WHERE `clan_id` = 22;
--> statement-breakpoint
DELETE FROM `clans` WHERE `id` = 22 AND `tag` = 'LALA' AND `name` = 'lol';
--> statement-breakpoint
DELETE FROM `db_ratings` WHERE `entry_id` IN (263, 283);
--> statement-breakpoint
DELETE FROM `db_entries` WHERE `id` = 283 AND `name` = 'Hellspawn Comshot 12';
--> statement-breakpoint
DELETE FROM `db_entries` WHERE `id` = 263 AND `name` = 'Black Eagle gun store';
--> statement-breakpoint
INSERT INTO `db_entries` (`kind`, `name`, `category`, `description`, `status`, `source_name`, `source_url`, `featured`, `type`, `manufacturer`, `drivetrain`, `auto_discovered`, `image_blob_key`, `created_at`, `updated_at`) SELECT 'Location', 'Draper Island', 'Other', 'Draper Island is a place named on Rockstar''s official Leonida map, released November 19, 2026. Nothing more about it is confirmed yet — its details will be confirmed in-game.', 'Confirmed in trailer', 'Rockstar Games — official GTA VI page', 'https://www.rockstargames.com/VI', 0, '', '', '', 0, '', 1795597200000, 1795597200000 WHERE NOT EXISTS (SELECT 1 FROM `db_entries` WHERE `name` = 'Draper Island');
--> statement-breakpoint
INSERT INTO `db_entries` (`kind`, `name`, `category`, `description`, `status`, `source_name`, `source_url`, `featured`, `type`, `manufacturer`, `drivetrain`, `auto_discovered`, `image_blob_key`, `created_at`, `updated_at`) SELECT 'Location', 'Millport', 'Other', 'Millport is a place named on Rockstar''s official Leonida map, released November 19, 2026. Nothing more about it is confirmed yet — its details will be confirmed in-game.', 'Confirmed in trailer', 'Rockstar Games — official GTA VI page', 'https://www.rockstargames.com/VI', 0, '', '', '', 0, '', 1795597200000, 1795597200000 WHERE NOT EXISTS (SELECT 1 FROM `db_entries` WHERE `name` = 'Millport');
--> statement-breakpoint
INSERT INTO `db_entries` (`kind`, `name`, `category`, `description`, `status`, `source_name`, `source_url`, `featured`, `type`, `manufacturer`, `drivetrain`, `auto_discovered`, `image_blob_key`, `created_at`, `updated_at`) SELECT 'Location', 'Belville', 'Other', 'Belville is a place named on Rockstar''s official Leonida map, released November 19, 2026. Nothing more about it is confirmed yet — its details will be confirmed in-game.', 'Confirmed in trailer', 'Rockstar Games — official GTA VI page', 'https://www.rockstargames.com/VI', 0, '', '', '', 0, '', 1795597200000, 1795597200000 WHERE NOT EXISTS (SELECT 1 FROM `db_entries` WHERE `name` = 'Belville');
--> statement-breakpoint
INSERT INTO `db_entries` (`kind`, `name`, `category`, `description`, `status`, `source_name`, `source_url`, `featured`, `type`, `manufacturer`, `drivetrain`, `auto_discovered`, `image_blob_key`, `created_at`, `updated_at`) SELECT 'Location', 'Waning Sands', 'Other', 'Waning Sands is a place named on Rockstar''s official Leonida map, released November 19, 2026. Nothing more about it is confirmed yet — its details will be confirmed in-game.', 'Confirmed in trailer', 'Rockstar Games — official GTA VI page', 'https://www.rockstargames.com/VI', 0, '', '', '', 0, '', 1795597200000, 1795597200000 WHERE NOT EXISTS (SELECT 1 FROM `db_entries` WHERE `name` = 'Waning Sands');
--> statement-breakpoint
INSERT INTO `db_entries` (`kind`, `name`, `category`, `description`, `status`, `source_name`, `source_url`, `featured`, `type`, `manufacturer`, `drivetrain`, `auto_discovered`, `image_blob_key`, `created_at`, `updated_at`) SELECT 'Location', 'Breakwater Quarry', 'Other', 'Breakwater Quarry is a place named on Rockstar''s official Leonida map, released November 19, 2026. Nothing more about it is confirmed yet — its details will be confirmed in-game.', 'Confirmed in trailer', 'Rockstar Games — official GTA VI page', 'https://www.rockstargames.com/VI', 0, '', '', '', 0, '', 1795597200000, 1795597200000 WHERE NOT EXISTS (SELECT 1 FROM `db_entries` WHERE `name` = 'Breakwater Quarry');
--> statement-breakpoint
INSERT INTO `db_entries` (`kind`, `name`, `category`, `description`, `status`, `source_name`, `source_url`, `featured`, `type`, `manufacturer`, `drivetrain`, `auto_discovered`, `image_blob_key`, `created_at`, `updated_at`) SELECT 'Location', 'Buckskin Swamp', 'Other', 'Buckskin Swamp is a place named on Rockstar''s official Leonida map, released November 19, 2026. Nothing more about it is confirmed yet — its details will be confirmed in-game.', 'Confirmed in trailer', 'Rockstar Games — official GTA VI page', 'https://www.rockstargames.com/VI', 0, '', '', '', 0, '', 1795597200000, 1795597200000 WHERE NOT EXISTS (SELECT 1 FROM `db_entries` WHERE `name` = 'Buckskin Swamp');
--> statement-breakpoint
INSERT INTO `db_entries` (`kind`, `name`, `category`, `description`, `status`, `source_name`, `source_url`, `featured`, `type`, `manufacturer`, `drivetrain`, `auto_discovered`, `image_blob_key`, `created_at`, `updated_at`) SELECT 'Location', 'Mile Zero Air Station', 'Other', 'Mile Zero Air Station is a place named on Rockstar''s official Leonida map, released November 19, 2026. Nothing more about it is confirmed yet — its details will be confirmed in-game.', 'Confirmed in trailer', 'Rockstar Games — official GTA VI page', 'https://www.rockstargames.com/VI', 0, '', '', '', 0, '', 1795597200000, 1795597200000 WHERE NOT EXISTS (SELECT 1 FROM `db_entries` WHERE `name` = 'Mile Zero Air Station');
--> statement-breakpoint
UPDATE `guides` SET `body` = 'Rockstar released the official GTA VI map on November 19, 2026 — a free download on rockstargames.com/VI (Downloads / Media, ''Leonida Map & Cover Art Poster''). It is a ''Visit Leonida'' tourist-style poster of the whole state, with the five counties: Lummox, Kelly, Leonard, Vice-Dale and Mariana. New official place names on it include Draper Island, Capri, Millport, Belville, Waning Sands, Breakwater Quarry, Buckskin Swamp and Mile Zero Air Station. The ViceSunshine Map is fan-made on licensed community tiles — it is not Rockstar''s map and never presents itself as official — but it uses the official county names and real place names only, no made-up names. Regions on the official map (treat exact in-game locations as unverified until you stand there in-game): Vice City — the main city. Leonida Keys — the island chain south of the city. Port Gellhorn — a coastal port area. Ambrosia — an inland industrial area. Mount Kalaga National Park — the wilderness and mountain region. How to explore well: 1. Let the story open the map. Early missions are a guided tour — the game shows you the regions in an order that makes them stick. 2. When you verify a location in-game (a shop, a safehouse, a collectible), that is when it becomes real information — ViceSunshine''s interactive pins are open now that the official map is out, so verified locations can be pinned as fact. 3. Screenshots help everyone: post your finds in the Feed as Easter Egg Finds or Gameplay with the region named, and report secrets in Easter Eggs with the approximate region — they start as Reported and are verified by the community. Official GTA VI page: https://www.rockstargames.com/VI — Rockstar''s page is the only source that can confirm a location before you visit it yourself.' WHERE `id` = 9;
--> statement-breakpoint
UPDATE `guides` SET `body` = 'The game is out — GTA VI launched November 19, 2026 on PS5 and Xbox Series X|S. This is the checklist for players starting now. 1) Install the latest patch first — check the Updates tab here for the newest version (01.002.002, November 23, 2026, fixes crashes, broken autosaves and story phone calls) and install it before you start the story. 2) Make sure you have space — the download needs up to 212 GB free, so clear space before you start, not during it. 3) Pick Fidelity or Performance mode in settings based on your TV: Fidelity for a 4K set, Performance for smoother driving. 4) Turn subtitles on — trailer dialogue suggests plenty of overlapping radio and street chatter worth catching. 5) Save early, save often, use more than one slot. Keep one save before big story choices so you can always go back.' WHERE `id` = 1;
--> statement-breakpoint
INSERT INTO `feed_posts` (`author_key`, `author`, `kind`, `title`, `body`, `media_url`, `media_urls`, `link_url`, `location`, `image_blob_key`, `auto`, `source_name`, `source_url`, `repost_of_id`, `shares`, `flagged`, `created_at`) SELECT 'gta-clipper-ai', 'GTA CLIPPER', 'News', 'Grand Theft Auto VI Launch Trailer', 'Rockstar Games'' official launch trailer for Grand Theft Auto VI. Posted automatically by GTA CLIPPER from youtube.com — a real video from its original creator; watch the original at the source. ViceSunshine never re-uploads videos.

#GTAVI #GTA6 #ViceSunshine #GTANews', 'https://www.youtube.com/watch?v=rz1B4B2yBZY', '', '', '', '', 1, 'youtube.com', 'https://www.youtube.com/watch?v=rz1B4B2yBZY', 0, 0, 0, 1795597200000 WHERE NOT EXISTS (SELECT 1 FROM `feed_posts` WHERE `media_url` LIKE '%rz1B4B2yBZY%' OR `source_url` LIKE '%rz1B4B2yBZY%');
--> statement-breakpoint
INSERT INTO `feed_posts` (`author_key`, `author`, `kind`, `title`, `body`, `media_url`, `media_urls`, `link_url`, `location`, `image_blob_key`, `auto`, `source_name`, `source_url`, `repost_of_id`, `shares`, `flagged`, `created_at`) SELECT 'gta-clipper-ai', 'GTA CLIPPER', 'News', 'GTA 6 Review', 'IGN''s review of Grand Theft Auto VI — IGN scored it 10/10. Posted automatically by GTA CLIPPER from youtube.com — a real video from its original creator; watch the original at the source. ViceSunshine never re-uploads videos.

#GTAVI #GTA6 #ViceSunshine #GTANews', 'https://www.youtube.com/watch?v=agBEh5aZ_Go', '', '', '', '', 1, 'youtube.com', 'https://www.youtube.com/watch?v=agBEh5aZ_Go', 0, 0, 0, 1795597200000 WHERE NOT EXISTS (SELECT 1 FROM `feed_posts` WHERE `media_url` LIKE '%agBEh5aZ_Go%' OR `source_url` LIKE '%agBEh5aZ_Go%');
--> statement-breakpoint
INSERT INTO `feed_posts` (`author_key`, `author`, `kind`, `title`, `body`, `media_url`, `media_urls`, `link_url`, `location`, `image_blob_key`, `auto`, `source_name`, `source_url`, `repost_of_id`, `shares`, `flagged`, `created_at`) SELECT 'gta-clipper-ai', 'GTA CLIPPER', 'News', 'Grand Theft Auto VI (GTA 6) - The Review', 'GameSpot''s review of Grand Theft Auto VI — GameSpot scored it 10/10. Posted automatically by GTA CLIPPER from youtube.com — a real video from its original creator; watch the original at the source. ViceSunshine never re-uploads videos.

#GTAVI #GTA6 #ViceSunshine #GTANews', 'https://www.youtube.com/watch?v=rAhUXOYNuH4', '', '', '', '', 1, 'youtube.com', 'https://www.youtube.com/watch?v=rAhUXOYNuH4', 0, 0, 0, 1795597200000 WHERE NOT EXISTS (SELECT 1 FROM `feed_posts` WHERE `media_url` LIKE '%rAhUXOYNuH4%' OR `source_url` LIKE '%rAhUXOYNuH4%');
--> statement-breakpoint
INSERT INTO `feed_posts` (`author_key`, `author`, `kind`, `title`, `body`, `media_url`, `media_urls`, `link_url`, `location`, `image_blob_key`, `auto`, `source_name`, `source_url`, `repost_of_id`, `shares`, `flagged`, `created_at`) SELECT 'gta-clipper-ai', 'GTA CLIPPER', 'News', '[4K HDR] Grand Theft Auto 6: Digital Foundry Tech Review', 'Digital Foundry''s tech review of Grand Theft Auto VI — 1440p/30fps, with no 60fps mode even on Pro. Posted automatically by GTA CLIPPER from youtube.com — a real video from its original creator; watch the original at the source. ViceSunshine never re-uploads videos.

#GTAVI #GTA6 #ViceSunshine #GTANews', 'https://www.youtube.com/watch?v=qsBU0bcpONA', '', '', '', '', 1, 'youtube.com', 'https://www.youtube.com/watch?v=qsBU0bcpONA', 0, 0, 0, 1795597200000 WHERE NOT EXISTS (SELECT 1 FROM `feed_posts` WHERE `media_url` LIKE '%qsBU0bcpONA%' OR `source_url` LIKE '%qsBU0bcpONA%');
