-- REVERTED (Nov 23 2026, owner's direction): the v461 Green Alien
-- change was undone at the owner's request — the website was not
-- meant to be touched. This migration is intentionally a no-op so
-- it can never seed the [CR7] THE GOAT crew or the green-alien
-- emblem / banner designs on a future run. The cleanup of any
-- already-seeded rows lives in migration 0097.
SELECT 1 WHERE 0;
