INSERT INTO meta (key, value) VALUES ('discord_invite_url', 'https://discord.gg/xHjeKF5PVe')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
