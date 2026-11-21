CREATE TABLE support_requests (
  id integer PRIMARY KEY AUTOINCREMENT,
  player_key text NOT NULL DEFAULT '',
  gamertag text NOT NULL DEFAULT '',
  topic text NOT NULL DEFAULT 'Other',
  details text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Open',
  created_at integer NOT NULL
);
