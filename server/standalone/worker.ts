// Background worker for ViceSunshine — replaces the 11 Muse managed
// cron jobs (space.json) with plain timed calls to the same actions.
// Run as a second Railway service: `bun run worker`.
// It calls the local server's /actions endpoint, so it needs the web
// service up and WORKER_BASE_URL set (default http://localhost:3000).
//
// Schedule (matches Muse):
//   news            refreshNews          every 3d
//                                    (slowed Nov 21, 2026: free Tavily key, 1,000/month,
//                                    ~100 credits per full round, ~9 rounds/month = ~900, safely
//                                    under the limit; game not fully released yet so slower
//                                    updates are fine; budget guard caps Tavily at 900)
//   feed-media      refreshFeedMedia     every 3d
//   clips           refreshTikTokClips   every 3d
//   db-sync         refreshDbEntries     every 3d
//   bugs            refreshBugs          every 3d
//   eggs            refreshEggContent    every 3d
//   moderation      automationSweep      every 3d
//   rockstar        refreshRockstarStatus every 5m — UNCHANGED, it is a direct fetch and uses no search credits (the action itself
//                   throttles to one real check per 60s, and a check
//                   requested in the last 3 minutes blocks duplicates,
//                   so frequent calls never pile up)
//   DISABLED: artwork generation (seedArtwork — needs an image-
//         generation provider, not configured; generate_media
//         throws, so running it would only record failures).
//
// What each job can actually add depends on the keys in Railway
// Variables (see README "Automatic updates"): without a search key
// (BRAVE_API_KEY / TAVILY_API_KEY) the refreshers run, stamp their
// "last run" time honestly, and add nothing new; without an AI key
// (OPENAI_API_KEY) Database auto-adds and Easter egg discovery add
// nothing, bugs fall back to their title rule, and Ask Vice answers
// from the site's own data. Nothing is ever faked.
//
// Smoke test (no keys needed — jobs run, add nothing, fail loudly):
//   bun run server/standalone/worker.ts --once
// Runs every enabled job once, prints each result, then exits
// (exit 1 if any job failed). Point WORKER_BASE_URL at the server.
const BASE = process.env.WORKER_BASE_URL ?? "http://localhost:3000";

async function call(action: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(`${BASE}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, args }),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: unknown; error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.data;
}

interface Job { name: string; action: string; everyMs: number; run: () => Promise<unknown> }
const jobs: Job[] = [
  { name: "news", action: "refreshNews", everyMs: 3 * 24 * 60 * 60_000, run: () => call("refreshNews") },
  { name: "feed-media", action: "refreshFeedMedia", everyMs: 3 * 24 * 60 * 60_000, run: () => call("refreshFeedMedia") },
  { name: "clips", action: "refreshTikTokClips", everyMs: 3 * 24 * 60 * 60_000, run: () => call("refreshTikTokClips") },
  { name: "db-sync", action: "refreshDbEntries", everyMs: 3 * 24 * 60 * 60_000, run: () => call("refreshDbEntries") },
  { name: "bugs", action: "refreshBugs", everyMs: 3 * 24 * 60 * 60_000, run: () => call("refreshBugs") },
  { name: "eggs", action: "refreshEggContent", everyMs: 3 * 24 * 60 * 60_000, run: () => call("refreshEggContent") },
  { name: "moderation-sweep", action: "automationSweep", everyMs: 3 * 24 * 60 * 60_000, run: () => call("automationSweep") },
  { name: "rockstar", action: "refreshRockstarStatus", everyMs: 5 * 60_000, run: () => call("refreshRockstarStatus") },
];

async function runJob(job: Job): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const started = Date.now();
  try {
    const result = await job.run();
    console.log(`[worker] ${job.name}: ok in ${Date.now() - started}ms`, JSON.stringify(result));
    return { ok: true, result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[worker] ${job.name}: FAILED`, msg);
    return { ok: false, error: msg };
  }
}

const searchConfigured = Boolean(process.env.BRAVE_API_KEY || process.env.TAVILY_API_KEY);
const aiConfigured = Boolean(process.env.OPENAI_API_KEY);
console.log(
  `[worker] search: ${searchConfigured ? "configured (Brave first, Tavily fallback)" : "NOT configured — refreshers will add nothing new"}` +
  ` | AI: ${aiConfigured ? "configured" : "NOT configured — Ask Vice answers from site data, Database auto-add and egg discovery are paused, image moderation is OFF"}` +
  ` | image generation: NOT configured — artwork generation disabled`,
);

if (process.argv.includes("--once")) {
  let failed = 0;
  for (const job of jobs) {
    const r = await runJob(job);
    if (!r.ok) failed += 1;
  }
  console.log(`[worker] --once done: ${jobs.length - failed}/${jobs.length} jobs ok`);
  process.exit(failed > 0 ? 1 : 0);
}

for (const job of jobs) {
  console.log(`[worker] ${job.name} every ${job.everyMs / 60_000} min`);
  void runJob(job);
  setInterval(() => void runJob(job), job.everyMs);
}
console.log("[worker] ViceSunshine worker running. Disabled job: artwork generation (no image provider — see README).");
