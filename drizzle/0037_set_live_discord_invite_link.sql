INSERT INTO meta (key, value) VALUES ('discord_invite_url', 'https://discord.gg/NDH9XxyVkW')
ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE meta.value = '';
