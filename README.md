# ViceSunshine — standalone website (vicesunshine.com)

The ViceSunshine fan community hub, ported from the Muse artifact
(`leonida-hub`) to a standalone website that runs on Railway at
**vicesunshine.com**.

**Identical to the Muse version.** Same design, same colours, same
pages, same features, same data, same TRN sign-up flow. Nothing
changed, nothing missing — the app code is the Muse code, copied
byte-for-byte except for the 4 changes listed in
[What was changed to port it](#what-was-changed-to-port-it). The
database and all pictures are the live copy from Muse (see
[The data](#the-data)).

## What was changed to port it

Only the platform layer changed. The app itself is untouched:

1. **`vendor/space-sdk/` — a small local stand-in for `@hatch/space-sdk`.**
   Same import surface (`defineAction`, `z`, `createActionClient`,
   `spaceQueryClient`, `fileToBase64`, `actionFields`, `buildClient`),
   re-implemented on plain HTTP + Bun SQLite. It is NOT the Muse SDK.
2. **`server/standalone/server.ts`** — a Bun HTTP server. Serves the
   built client and dispatches `POST ./actions` to the same 200
   actions. Same `{action, args}` protocol the Muse client already
   used.
3. **`server/standalone/email.ts` + one change in `server/src/actions.ts`** —
   code emails are now sent by a **direct Resend API call** instead of
   a spawned Gmail-connector agent task. Same branded dark HTML email,
   same subjects, same 6-digit code, same 1-minute expiry. The rest
   of `actions.ts` is byte-identical to Muse.
4. **`client/src/App.tsx` — 1 import changed.** `actionFields` is now
   imported from `./fields` (a runtime Proxy) instead of the Muse
   build-time macro. Same behaviour — the props are only ever spread
   onto inputs — and the server still enforces the Zod schemas.
   `diff` against the Muse original shows this as the ONLY change.
5. **`server/standalone/worker.ts`** — replaces the 11 Muse cron jobs
   with timed calls to the same refresh actions (see Cron jobs below).
   Schedule matches Muse (news/feed hourly, clips 30m, Database and
   eggs 6-hourly, bugs 3-hourly, moderation hourly, Rockstar every
   5m). `bun run server/standalone/worker.ts --once` runs every
   enabled job once for a smoke test.
6. **`server/standalone/ctx.ts` — search + AI wiring.** `web_search`
   uses the Brave Search API first (free 2,000/mo) with Tavily as
   fallback (free 1,000/mo), both from env vars only, behind a
   monthly budget guard so a free quota is never hammered. `inference`
   uses any OpenAI-compatible API when `OPENAI_API_KEY` is set (the
   free Google AI Studio Gemini tier works this way) for Ask Vice's
   full answers, Database / bug / egg extraction and real image
   moderation; without a key it keeps the old honest fallbacks.
   `agent.spawnTask` gives the Rockstar checker a real direct read
   of Rockstar's own status page when it can be reached, and reports
   `checked: false` when it cannot.
7. **`Dockerfile`, `railway.toml`, `.env.example`** — new, for Railway.

Everything else — `client/src/App.tsx` (23,119 lines), `server/src/actions.ts`
(15,597 lines, 200 actions), `server/src/schema.ts`, the 65 drizzle
migrations, `app.db`, `blobs/` — is the Muse copy, unchanged.

## The data

Copied from Muse on Nov 21, 2026 (~03:57 UTC) and re-synced to the live Muse copy at ~04:20 UTC, verified after the copy:

| Table | Rows |
|---|---|
| profiles (incl. ~200 seeded bot accounts) | 201 |
| db_entries | 261 |
| feed_posts | 604 |
| feed_comments / feed_reactions | 48 / 561 |
| clans / clan_members | 20 / 200 |
| profile_follows | 28,000 |
| rank_point_events | 1,232 |
| news | 84 |
| guides / eggs / egg_media | 12 / 17 / 150 |
| bugs / events | 36 / 3 |
| blob pictures | 522 files |

`app.db` integrity check: **ok**. Blob index: **ok**, 522 rows, 522 files.
The Muse version stays live as a fallback. Nothing was changed in it.

## Sign-up flow (TRN, unchanged)

Email → CREATE NEW ACCOUNT? → Create New → VERIFY YOUR EMAIL (code)
→ username → password → straight to Profile. No code skip. The code
is 6 digits, lives 1 minute, resend after 20 seconds. The only
difference from Muse: the code email is now sent by Resend directly
(seconds), instead of through a Gmail-connector agent task.

## Cron jobs (the 11 Muse managed jobs)

| Muse job | Standalone | Status |
|---|---|---|
| daily-news-refresh, auto-news-hourly | worker: `refreshNews` hourly | RUNS — adds new items once a search key is set (below) |
| daily-feed-media, auto-feed-media | worker: `refreshFeedMedia` hourly | RUNS — same note |
| auto-clips-refresh | worker: `refreshTikTokClips` every 30m | RUNS — same note |
| auto-db-sync, db-live-sync | worker: `refreshDbEntries` every 6h | RUNS — needs a search key AND an AI key to add entries (below) |
| auto-bugs-refresh | worker: `refreshBugs` every 3h | RUNS — needs a search key; works without an AI key (title fallback) |
| auto-eggs-refresh | worker: `refreshEggContent` every 6h | RUNS — per-egg videos/guides need a search key; discovery of brand-new eggs also needs an AI key |
| auto-moderation-sweep | worker: `automationSweep` hourly | RUNS — pure text screening, works fully |
| artwork-generation | — | DISABLED — needs an image-generation provider |
| rockstar-status | worker: `refreshRockstarStatus` every 5m | RUNS — tries a real direct read of Rockstar's own status page; if that page cannot be reached from the server it honestly reports `checked: false` and keeps the last real status instead of faking a check |

## Automatic updates — what works on Railway

| Feature | Works on Railway now? | Needs what? | Free? |
|---|---|---|---|
| New News / patch notes | Yes, once set up | Search key: `BRAVE_API_KEY` (free 2,000/mo) or `TAVILY_API_KEY` (free 1,000/mo) | Yes — free tiers |
| New Feed media (videos) | Yes, once set up | Search key (as above) | Yes |
| New TikTok Clips | Yes, once set up | Search key (as above) | Yes |
| Bug tracker auto-finds | Yes, once set up | Search key; AI key optional (without it, only results whose titles name a bug are added) | Yes |
| Easter egg media (videos/guides per egg) | Yes, once set up | Search key | Yes |
| Easter egg discovery (brand-new eggs) | Only with an AI key | Search key + `OPENAI_API_KEY` | Yes, on a free AI tier (below) |
| Database auto-add / update | Only with an AI key | Search key + `OPENAI_API_KEY` | Yes, on a free AI tier (below) |
| Ask Vice full answers | Site-data answers only | `OPENAI_API_KEY` for full composed answers; without it Vice lists what it found in News / Database / Events and links to the pages, and never invents anything | Yes, on a free AI tier (below) |
| Image moderation (uploads) | OFF until an AI key is set | `OPENAI_API_KEY` (vision) — then uploaded JPEG/PNG pictures are actually screened before storage | Yes, on a free AI tier (below) |
| Text moderation (posts, comments, names, bios) | Yes — works fully, no key needed | Nothing | Yes |
| Rockstar service status | Tries a real check every 5m | Nothing — but it only works if Rockstar's status page is reachable from Railway's network; if not, it says so honestly and keeps the last real status | Yes |
| New pictures (Database / avatar / season cards) | No | An image-generation provider — none is wired in, and there is no good free one. Existing 522 pictures all show. | — |
| Code emails (sign-up / sign-in / reset) | Yes, once set up | Resend account + `RESEND_API_KEY` (free 3,000/mo) | Yes |

### Free API keys (where to get them, no card needed)

- **Brave Search** — https://brave.com/search/api → sign up, create an API key, put it in Railway as `BRAVE_API_KEY`. Free: 2,000 searches/month.
- **Tavily** — https://tavily.com → sign up, API key, `TAVILY_API_KEY`. Free: 1,000 searches/month. Used only if Brave fails or is not set.
- **AI (Gemini, free)** — https://aistudio.google.com → Create API key (free tier, no card). In Railway set `OPENAI_API_KEY` = that key, `OPENAI_BASE_URL` = `https://generativelanguage.googleapis.com/v1beta/openai/`, `OPENAI_MODEL` = `gemini-2.5-flash`. That one key powers Ask Vice's full answers, Database / bug / egg extraction, and image moderation. (Or use OpenAI itself, paid: leave `OPENAI_BASE_URL` unset, `OPENAI_MODEL` = `gpt-4o-mini`.)
- **Resend** — https://resend.com → free 3,000 emails/month (see Deploy step 3).

### Free-tier maths — read this before expecting hourly updates all month

The free search tiers are small compared with Muse's hourly cadence. At the worker's schedule the refreshers use roughly 500 searches a day (News 4 queries × 24, Feed 9 × 24, Clips 3 × 48, Database 5 × 4, Bugs 5 × 8, Eggs ~14 × 4). So **one free Brave key (2,000/month) lasts about 4 days**, then the budget guard pauses searches until next month and the site keeps showing everything it already has. Adding Tavily adds about 2 more days. That is the honest limit of the free tiers — Muse's own search had no such cap, and no code change can invent more free searches. To stretch a free key across the whole month, slow the worker down (for example News/Feed/Clips every 6 hours instead of hourly — about 130 searches a day, inside the free tier), or add a paid search plan later. The budget guard (`SEARCH_MONTHLY_BUDGET`, default 1,800 with Brave / 900 with Tavily only) stops searches at the limit instead of hammering a dead quota, and the worker logs when it pauses.

## What does NOT work yet (honest list)

- **Code emails need Resend set up** (see Deploy step 3). Until then,
  sign-up / sign-in / password reset fail with a clear message saying
  email is not configured — they do NOT pretend the email was sent.
- **Auto-refresh adds no NEW news / feed media / clips / database
  entries / bugs / Easter eggs** until a search key is configured
  (`BRAVE_API_KEY` / `TAVILY_API_KEY` in Railway Variables).
  Everything already in the site (84 news, 261 database entries, 604
  feed posts…) shows normally; only the automatic discovery of new
  items is paused. See the table above.
- **Database auto-adds, Easter egg discovery and Ask Vice's full
  answers need an AI key too** (`OPENAI_API_KEY` — free Gemini tier
  works, see above). Without it, Ask Vice answers from the site's own
  data only, Database entries are never auto-added, and egg discovery
  is skipped. Bugs still work without it (title fallback).
- **No new Database / avatar / season-card pictures** can be
  generated until an image provider is configured. The 522 existing
  pictures all show. There is no good free image provider, so this
  stays off until Ben chooses a paid one.
- **Image moderation is OFF** until an AI key is set (see table).
  The text screen for posts, comments, names and bios still runs.
  Do not open public uploads widely until a moderation provider is
  added, or keep uploads as they are.
- **Rockstar service status** tries a real check every 5 minutes,
  but only works if Rockstar's status page is reachable from the
  server — it was not reachable from the Muse VM, so it may also
  fail on Railway. When it fails it says so honestly (`checked:
  false`) and keeps the last real status; it never invents one.
- **Stripe is still in test mode** (same as in Muse). Premium payments
  are not live until Stripe Live is activated — Ben's step, bank
  details go into Stripe directly, never in chat.

## What was tested locally (Nov 21, 2026, no external accounts)

- `bun install` — ok (59 packages).
- Server typecheck — clean. Client typecheck — clean except 7
  pre-existing unused-variable warnings in `App.tsx` that are also in
  the Muse original and never blocked the Muse build (Bun.build does
  not typecheck).
- `bun run build` — ok. Client bundle 38 MB, `client/dist/index.html`
  + 66 assets. TRN sign-up headings ("What's your email?",
  "Create new account?", "Verify your email", "Welcome back!") and
  the ViceSunshine colours (#FF2E88, #0b0b14) are in the built bundle.
- Server started on port 3100: `/health` → `{"ok":true}`;
  `GET /` → 200; `GET /blobs/db-art/entry-1` → 200, 330,282 bytes,
  `image/webp` (the 556's picture, same as Muse).
- Actions against the copied database, all returning real data:
  `getHub` (84 news, 35 bugs, 20 clans, 200 members — re-checked after re-sync), `getServerStatus`
  (201 players), `getSeason`, `listNews`, `listDbEntries`,
  `listFeed`, `getProfile`, `getCustomise`, `clanRankings`,
  `automationSweep` (0 flagged), `askVice` (fallback answer from
  site data), `refreshRockstarStatus` (`checked: false`, honest).
- `requestEmailCode` with a Gmail address and no Resend key → clear
  error "Email sending is not configured on this server
  (RESEND_API_KEY is missing)". No email was sent, no test account
  was created. (The test code row was deleted from the seed database
  afterwards.)
- Worker smoke test: all 6 enabled jobs ran ok against the live
  server in one tick.
- **Automatic-updates wiring (Nov 21, 2026, no keys):** `bun run
  server/standalone/worker.ts --once` against a throwaway copy of
  the database — **8/8 jobs ok** (news, feed-media, clips, db-sync,
  bugs, eggs, moderation-sweep, rockstar), all `added: 0`, counts
  unchanged afterwards (news 84, db_entries 261, feed_posts 604,
  bugs 36). Rockstar returned `checked: false` honestly — its
  status page is not reachable from this VM. A second run with a
  deliberately invalid `BRAVE_API_KEY` also added nothing and did
  not crash; Ask Vice fell back to its site-data answer. The live
  search / AI paths are untested end-to-end (no real keys exist
  yet) — the first run with a real Brave key is the proof that
  matters, and it will show up as `added > 0` in the worker log.
- **Not tested:** a real browser sign-up end-to-end (needs Resend),
  a real payment, Railway deploy, DNS. Those need Ben's accounts
  (below).

## Deploy — Ben's steps

### 1. Put this repo on GitHub (one time)
```bash
cd ~/workspace/vicesunshine-standalone
git init && git add -A && git commit -m "ViceSunshine standalone (ported from Muse)"
# create an empty repo named vicesunshine on github.com, then:
git remote add origin https://github.com/<you>/vicesunshine.git
git push -u origin main
```
(The repo is ~255 MB because it carries the seed database and all
512 pictures. That is expected — Railway needs them in the image.)

### 2. Railway — web service
1. Go to https://railway.app → New Project → Deploy from GitHub repo
   → pick `vicesunshine`.
2. Add a **Volume**, mount path **`/data`** (this is where `app.db`
   and `blobs/` live, so accounts and pictures survive restarts and
   redeploys). First boot copies the seed data into the volume.
3. Variables → add `RESEND_API_KEY` (step 3) and `EMAIL_FROM`
   (`ViceSunshine <noreply@vicesunshine.com>`). Railway sets `PORT`
   itself. Optional, for automatic updates (see "Automatic updates"
   above): `BRAVE_API_KEY`, `TAVILY_API_KEY`, `OPENAI_API_KEY`,
   `OPENAI_BASE_URL`, `OPENAI_MODEL`, `SEARCH_MONTHLY_BUDGET`.
   Never paste a real key into the repo or into chat.
4. Deploy. Railway builds the Dockerfile, runs `bun run build`, and
   starts the server. Health check: `/health`.
5. Settings → Generate Domain, to get the Railway address
   (e.g. `vicesunshine-production.up.railway.app`). Check the site
   loads there first.

### 3. Resend — code emails (needed before anyone can sign up)
1. Go to https://resend.com → sign up (free tier is enough to start).
2. Domains → Add Domain → `vicesunshine.com` → add the DNS records
   Resend shows (SPF / DKIM / DMARC) in Spaceship (same place as step 4).
3. Wait for the domain to show Verified in Resend.
4. API Keys → Create API Key → copy it.
5. Railway → your service → Variables → `RESEND_API_KEY` = the key.
   Never paste the key in chat or in the repo.
6. Redeploy the Railway service. Then test sign-up yourself: the code
   email should arrive in seconds from `noreply@vicesunshine.com`.

### 4. Spaceship — point the domain at Railway
1. Spaceship → vicesunshine.com → DNS / Advanced DNS.
2. Add a **CNAME** record: Host `@`, Value = the Railway domain from
   step 2.5, TTL Automatic. (If Spaceship will not take a CNAME on
   `@`, use the A-record / ALIAS option Railway shows instead.)
3. Wait for DNS to spread (usually minutes, up to a few hours).
4. Open https://vicesunshine.com — it should show ViceSunshine.
   Railway issues the HTTPS certificate automatically.

### 5. Railway — worker service (background refresh)
Same repo, second service: Settings → Start Command
`bun run worker` (and set `WORKER_BASE_URL` to the web service's
internal URL, e.g. `http://vicesunshine.railway.internal:3000`).
No volume needed for the worker — it calls the web service's actions.
Set the same search / AI variables on the worker service too (it is
the worker process that reads them). Smoke test first, locally:
`bun run server/standalone/worker.ts --once` runs every enabled job
once against a running server and exits (exit 1 if any job failed).

## Run it locally

```bash
bun install
bun run build        # builds client/dist
bun run start        # server on http://localhost:3000
# in another terminal, with the server running:
bun run worker       # background refresh jobs
```

Copy `.env.example` to `.env` for local settings. Without
`RESEND_API_KEY`, code emails fail loudly (see above) — everything
else works.

## Files

- `client/src/` — React app (Muse copy, 1 import changed)
- `server/src/` — actions + schema (Muse copy, email delivery changed)
- `server/standalone/` — server, Ctx, blob store, Resend email, worker
- `vendor/space-sdk/` — standalone stand-in for `@hatch/space-sdk`
- `drizzle/` — 65 migrations (already applied to the copied `app.db`)
- `app.db`, `blobs/` — live data snapshot from Muse
- `Dockerfile`, `railway.toml`, `.env.example` — deploy config
