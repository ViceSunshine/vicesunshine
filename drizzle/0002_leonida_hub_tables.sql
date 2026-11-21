DROP TABLE IF EXISTS entries;
--> statement-breakpoint
CREATE TABLE news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Community',
  source_name TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE patches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL,
  release_date TEXT NOT NULL DEFAULT '',
  size_ps5 TEXT NOT NULL DEFAULT '',
  size_xbox TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT 'No official patch notes published',
  source_url TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE bugs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'PS5',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Reported',
  fixed_in TEXT NOT NULL DEFAULT '',
  workaround TEXT NOT NULL DEFAULT '',
  votes INTEGER NOT NULL DEFAULT 0,
  reporter TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE missions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'Story',
  region TEXT NOT NULL DEFAULT '',
  characters TEXT NOT NULL DEFAULT '',
  walkthrough TEXT NOT NULL DEFAULT '',
  rewards TEXT NOT NULL DEFAULT '',
  tips TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE mission_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id INTEGER NOT NULL,
  player_key TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE eggs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  how_to TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Reported',
  x REAL NOT NULL DEFAULT 50,
  y REAL NOT NULL DEFAULT 50,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE map_pins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  layer TEXT NOT NULL DEFAULT 'Activities',
  detail TEXT NOT NULL DEFAULT '',
  x REAL NOT NULL DEFAULT 50,
  y REAL NOT NULL DEFAULT 50,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE guides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Beginner',
  body TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_key TEXT NOT NULL,
  gamertag TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'PS5',
  region TEXT NOT NULL DEFAULT '',
  playstyle TEXT NOT NULL DEFAULT '',
  reputation INTEGER NOT NULL DEFAULT 0,
  premium INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE clans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  tag TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#FF2E88',
  motto TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT 'Both',
  region TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'English',
  playstyle TEXT NOT NULL DEFAULT 'Chill',
  privacy TEXT NOT NULL DEFAULT 'Public',
  max_members INTEGER NOT NULL DEFAULT 50,
  events_held INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  faction TEXT NOT NULL DEFAULT '',
  faction_points INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE clan_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clan_id INTEGER NOT NULL,
  player_key TEXT NOT NULL,
  gamertag TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'PS5',
  role TEXT NOT NULL DEFAULT 'Recruit',
  squad TEXT NOT NULL DEFAULT '',
  joined_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE clan_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clan_id INTEGER NOT NULL,
  player_key TEXT NOT NULL,
  gamertag TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Pending',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE clan_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clan_id INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'feed',
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE clan_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clan_id INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE squads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clan_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  lead_gamertag TEXT NOT NULL DEFAULT '',
  focus TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE lfg_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_key TEXT NOT NULL,
  author TEXT NOT NULL,
  title TEXT NOT NULL,
  activity TEXT NOT NULL DEFAULT 'Explore',
  platform TEXT NOT NULL DEFAULT 'PS5',
  when_text TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'English',
  skill_level TEXT NOT NULL DEFAULT 'Any',
  mic_required INTEGER NOT NULL DEFAULT 0,
  spots_total INTEGER NOT NULL DEFAULT 4,
  spots_filled INTEGER NOT NULL DEFAULT 1,
  closed INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Car Meet',
  starts_at TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  platform TEXT NOT NULL DEFAULT 'Both',
  max_players INTEGER NOT NULL DEFAULT 16,
  description TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '',
  prize TEXT NOT NULL DEFAULT 'Bragging rights + site badge',
  host TEXT NOT NULL DEFAULT '',
  clan_id INTEGER,
  results TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE rsvps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  player_key TEXT NOT NULL,
  gamertag TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Going',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
--> statement-breakpoint
INSERT INTO news (title, summary, category, source_name, source_url, published_at, created_at) VALUES
('GTA VI launches November 19, 2026 — date holds ten days out', 'Rockstar, Take-Two and both console stores still list Thursday, November 19, 2026 for PlayStation 5 and Xbox Series X|S. Take-Two''s November 9 results release repeated the date, with the CEO calling launch ''ten days away''. No PC or mobile version has been announced.', 'Official', 'GamingRoute (citing Rockstar / Take-Two)', 'https://gamingroute.com/is-gta-6-delayed/', '2026-11-09', 1794000000000),
('Pre-load is live: clear up to 212 GB before launch day', 'Digital pre-loading opened November 10 on PS5 and Xbox Series X|S. Rockstar''s November 3 Pre-Load FAQ says the game needs up to 212 GB of free space depending on device, and it stays locked until midnight local time on November 19. Physical copies are code-in-box, expected at retailers from November 12.', 'Official', 'Save Point Six (citing Rockstar Support)', 'https://savepointsix.com/guides/gta6-release-check/', '2026-11-03', 1793900000000),
('Rockstar opens the Launch Gallery: nearly 40 official screenshots', 'Two weeks before release, Rockstar added a Launch Gallery of official screenshots spanning Vice City and the wider state of Leonida to the GTA VI site. It is a showcase, not a feature reveal — no new gameplay details were attached.', 'Official', 'GameFlash', 'https://www.gameflash.net/article/gta-vi-launch-gallery-adds-nearly-40-official-screenshots-two-weeks-before-release', '2026-11-05', 1793950000000),
('Single-player at launch: GTA VI Online has NOT been announced', 'GTA VI launches as a single-player experience. Rockstar has not announced a GTA VI Online mode or a date for one — reporting that points to 2027 is unconfirmed. Everything multiplayer-flavoured on this hub (clans, LFG, events) is community-organised on the website, not in-game multiplayer. Existing GTA Online (GTA V) keeps running separately.', 'Community', 'Leonida Hub editors', '', '2026-11-18', 1795050000000);
--> statement-breakpoint
INSERT INTO patches (version, release_date, size_ps5, size_xbox, notes, source_url, created_at) VALUES
('01.002.000', '2026-11-13', '~1.07 GB', '~1.07 GB', 'No official patch notes published', '', 1794400000000),
('01.002.001', '2026-11-16', '602.5 MB', '1.59 GB', 'No official patch notes published', '', 1794700000000);
--> statement-breakpoint
INSERT INTO eggs (name, location, how_to, status, x, y, created_at) VALUES
('Ocean View Hotel return', 'Ocean Drive, Vice Beach', 'Walk the Ocean Drive strip in Vice Beach and look for the art-deco hotel frontage from the 1986 classic. Players report the building is back — bring a screenshot to help verify it.', 'Reported', 78, 62, 1795000000000),
('Flash FM lives on', 'In-game radio', 'Cycle the radio dial while driving in Vice City. Listeners report a familiar pop station identity among the stations — unconfirmed until multiple players capture the station ID.', 'Rumor', 50, 50, 1795001000000),
('Valentina return', 'Leonida Keys', 'Search the Keys for references to Valentina, the fan-favourite character players believe returns. Treat every sighting as a rumour until photo evidence lands.', 'Rumor', 30, 84, 1795002000000),
('Vercetti Estate references', 'Starfish Island area, Vice City', 'Check the mansion district on the island between the causeways. Players report estate details that echo a certain 1986 empire — verification photos wanted.', 'Reported', 62, 55, 1795003000000);
--> statement-breakpoint
INSERT INTO map_pins (name, layer, detail, x, y, created_at) VALUES
('Ocean View Hotel (reported)', 'Easter Eggs', 'Reported return of the Ocean Drive landmark. See Easter Eggs for verification status.', 78, 62, 1795000000000),
('Vice Beach strip', 'Activities', 'Beach boulevard cruising and photo spots along Ocean Drive.', 82, 58, 1795000100000),
('Downtown Vice City', 'Shops', 'Dense downtown blocks — expect the city''s main shopping and services here.', 58, 48, 1795000200000),
('Leonida Keys causeway', 'Activities', 'The long drive south to the Keys — a favourite community cruise route.', 38, 76, 1795000300000),
('Port Gellhorn', 'Activities', 'Working port town on the coast, seen in trailers.', 22, 38, 1795000400000),
('Mount Kalaga', 'Activities', 'High country in the north of Leonida — hiking and off-road country.', 44, 16, 1795000500000),
('Ambrosia sugar country', 'Collectibles', 'Farms and refinery country in central Leonida. Collectible hunting ground — pins added as players verify finds.', 52, 34, 1795000600000);
--> statement-breakpoint
INSERT INTO guides (title, category, body, author, created_at) VALUES
('Launch night checklist: preload, space and settings', 'Beginner', '1) Pre-load now — the download needs up to 212 GB free, so clear space before launch night, not during it. 2) The game unlocks at midnight local time on November 19. 3) On first boot, check the Updates tab here for the day-one patch size on your platform before you start the story. 4) Pick Fidelity or Performance mode in settings based on your TV: Fidelity for a 4K set, Performance for smoother driving. 5) Turn subtitles on — trailer dialogue suggests plenty of overlapping radio and street chatter worth catching.', 'Leonida Hub editors', 1795000000000),
('Spoiler survival guide for launch week', 'Beginner', 'Story details will flood social feeds within hours of unlock. This hub keeps spoilers OFF by default in the Missions database — details stay hidden until you tap Show Spoilers. Mute the game''s hashtags on social apps, avoid comment sections on trailer videos, and if you are in a clan, ask your Leader to keep the clan feed spoiler-tagged for the first two weeks.', 'Leonida Hub editors', 1795001000000),
('How the bug tracker verification works', 'Help', 'Found a glitch? File it with your platform and exact steps to reproduce — reports with clear steps get verified fastest. A bug moves from Reported to Confirmed only when multiple players reproduce it, and to Fixed only when a patch version is known. Tap ''I have this too'' on any bug you hit: vote counts are how moderators prioritise. Never download ''fixes'' or APKs from strangers — this site will never host game downloads.', 'Leonida Hub editors', 1795002000000);
