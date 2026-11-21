// Builds the platform Ctx the copied ViceSunshine actions expect,
// on standalone primitives instead of the Muse runtime:
//
// - ctx.db      -> drizzle-orm over Bun's SQLite, on the copied app.db
// - ctx.blobs   -> server/standalone/blobs.ts (copied blob store)
// - ctx.agent   -> NOT available standalone, except for one case:
//                  the Rockstar status checker (see tryRockstarCheck
//                  below) attempts a real direct fetch of Rockstar's
//                  own status page and stores exactly what it says.
//                  If that page cannot be reached from this server,
//                  spawnTask returns ok:false and the last real
//                  status stays on screen — nothing is ever guessed.
// - ctx.inference -> OpenAI-compatible AI when OPENAI_API_KEY is set
//                  (any OpenAI-compatible endpoint via
//                  OPENAI_BASE_URL / OPENAI_MODEL — the free Google AI
//                  Studio Gemini tier works this way, see README).
//                  Without a key it behaves as before: the image-
//                  moderation schema answers {allowed: true} so
//                  uploads keep working (moderation is OFF — see
//                  README), and everything else throws so callers
//                  fall back (Ask Vice answers from the site's own
//                  data, refreshBugs uses its title fallback,
//                  refreshDbEntries / egg discovery add nothing).
// - ctx.tool.web_search -> Brave Search API first (free 2,000/mo),
//                  Tavily as fallback (free 1,000/mo), both from env
//                  vars only. A monthly budget guard (meta
//                  `search_usage:YYYY-MM`, default 1,800 Brave / 900
//                  Tavily, override SEARCH_MONTHLY_BUDGET) stops
//                  searches when the free quota is used up instead
//                  of hammering a dead quota. With no key configured
//                  it returns no results and refreshers add nothing.
// - ctx.tool.generate_media -> throws; no image provider is
//                  configured (see README "Pictures"). Callers catch
//                  and skip, and record the failure in meta
//                  (db_art_last_error). No fake pictures are ever made.
// - ctx.invalidateQueries / ctx.emit -> no-ops. The client refetches
//                  through React Query after its own mutations.
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { z } from "zod";
import * as schema from "../src/schema";
import type { Ctx } from "@hatch/space-sdk";
import { FileBlobClient } from "./blobs";
import { InferenceSchemaError } from "@hatch/space-sdk";

let sqlite: Database | null = null;
let drizzleDb: ReturnType<typeof drizzle> | null = null;
let blobs: FileBlobClient | null = null;

export function getDb() {
  if (!drizzleDb) {
    const dbPath = process.env.DATABASE_PATH ?? joinSpace("app.db");
    sqlite = new Database(dbPath, { readonly: false });
    sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    const base = drizzle(sqlite, { schema });
    // drizzle's Bun SQLite driver has no db.batch() (the LibSQL driver
    // did). Two actions use it — resetTestAccounts and seedBots — and
    // both only await it, so run the statements in order. Same rows,
    // same result, no batch API needed.
    drizzleDb = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (stmts: unknown[]) => {
            const out: unknown[] = [];
            for (const stmt of stmts) out.push(await (stmt as PromiseLike<unknown>));
            return out;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof base;
  }
  return drizzleDb;
}

export function joinSpace(rel: string): string {
  const dir = process.env.SPACE_DIR ?? process.cwd();
  return `${dir}/${rel}`;
}

export function getBlobs(): FileBlobClient {
  if (!blobs) blobs = new FileBlobClient(process.env.SPACE_DIR ?? process.cwd());
  return blobs;
}

// ---- Web search: Brave first, Tavily fallback, free-tier budget ----

type SearchResult = { title: string; url: string; snippet: string };

async function braveSearch(query: string, key: string): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10&search_lang=en`;
  const res = await fetch(url, {
    headers: { "X-Subscription-Token": key, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Brave Search returned ${res.status}`);
  const data = (await res.json()) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
    news?: { results?: { title?: string; url?: string; description?: string }[] };
  };
  const rows = [...(data.web?.results ?? []), ...(data.news?.results ?? [])];
  return rows
    .filter((r) => typeof r.url === "string" && typeof r.title === "string")
    .map((r) => ({ title: r.title as string, url: r.url as string, snippet: r.description ?? "" }));
}

async function tavilySearch(query: string, key: string): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: 10, search_depth: "basic", include_answer: false }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Tavily returned ${res.status}`);
  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (data.results ?? [])
    .filter((r) => typeof r.url === "string" && typeof r.title === "string")
    .map((r) => ({ title: r.title as string, url: r.url as string, snippet: r.content ?? "" }));
}

// Monthly search budget, stored in meta so it survives restarts.
// Defaults keep the free tiers safe: Brave 2,000/mo -> 1,800 counted,
// Tavily 1,000/mo -> 900 counted. Override with SEARCH_MONTHLY_BUDGET.
async function searchBudgetRemaining(): Promise<number> {
  const configured = Number(process.env.SEARCH_MONTHLY_BUDGET ?? "");
  const budget =
    Number.isFinite(configured) && configured > 0
      ? configured
      : process.env.BRAVE_API_KEY
        ? 1800
        : 900;
  const monthKey = `search_usage:${new Date().toISOString().slice(0, 7)}`;
  const db = getDb();
  const rows = await db.select().from(schema.meta).where(eq(schema.meta.key, monthKey));
  const used = Number(rows[0]?.value ?? 0) || 0;
  return budget - used;
}

async function countSearchUse(): Promise<void> {
  const monthKey = `search_usage:${new Date().toISOString().slice(0, 7)}`;
  const db = getDb();
  const rows = await db.select().from(schema.meta).where(eq(schema.meta.key, monthKey));
  const used = (Number(rows[0]?.value ?? 0) || 0) + 1;
  await db
    .insert(schema.meta)
    .values({ key: monthKey, value: String(used) })
    .onConflictDoUpdate({ target: schema.meta.key, set: { value: String(used) } });
}

let budgetWarnedFor = "";

async function webSearch(query: string): Promise<{ content: { results: SearchResult[] } }> {
  const braveKey = process.env.BRAVE_API_KEY?.trim() || "";
  const tavilyKey = process.env.TAVILY_API_KEY?.trim() || "";
  if (!braveKey && !tavilyKey) return { content: { results: [] } };
  if ((await searchBudgetRemaining()) <= 0) {
    const month = new Date().toISOString().slice(0, 7);
    if (budgetWarnedFor !== month) {
      budgetWarnedFor = month;
      console.warn(`[search] monthly free search budget used up (${month}) — refreshers will add nothing new until next month. Add TAVILY_API_KEY or raise SEARCH_MONTHLY_BUDGET to continue.`);
    }
    return { content: { results: [] } };
  }
  const errors: string[] = [];
  if (braveKey) {
    try {
      const results = await braveSearch(query, braveKey);
      await countSearchUse();
      return { content: { results } };
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (tavilyKey) {
    try {
      const results = await tavilySearch(query, tavilyKey);
      await countSearchUse();
      return { content: { results } };
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  console.warn(`[search] all search providers failed for "${query.slice(0, 60)}": ${errors.join("; ")}`);
  return { content: { results: [] } };
}

// ---- AI inference: OpenAI-compatible API when a key is set ----

async function openAiCompatibleComplete<T extends z.ZodType>(
  prompt: string,
  options: { schema: T; timeout_secs?: number; images?: readonly { dataBase64: string; mimeType?: string; filename?: string }[] },
): Promise<z.infer<T> | null> {
  const apiKey = process.env.OPENAI_API_KEY?.trim() || "";
  if (!apiKey) return null;
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const userContent: unknown[] = [{ type: "text", text: prompt }];
  for (const img of options.images ?? []) {
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${img.mimeType ?? "image/jpeg"};base64,${img.dataBase64}` },
    });
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a precise JSON extraction and answering helper for ViceSunshine, a GTA VI fan community app. Reply with ONLY a JSON object matching the requested schema. Never invent facts that are not in the prompt; if the prompt gives no matching item, return the empty form of the schema (empty list / empty strings).",
        },
        { role: "user", content: userContent.length === 1 ? prompt : userContent },
      ],
      temperature: 0,
      max_tokens: 4000,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout((options.timeout_secs ?? 90) * 1000),
  });
  if (!res.ok) throw new Error(`AI provider returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("AI provider returned no text");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("AI provider returned text that is not JSON");
    parsed = JSON.parse(m[0]);
  }
  const checked = options.schema.safeParse(parsed);
  if (!checked.success) throw new InferenceSchemaError(checked.error.issues);
  return checked.data as z.infer<T>;
}

// ---- Rockstar status: one real direct read of Rockstar's own page ----

const ROCKSTAR_STATUS_URL = "https://support.rockstargames.com/servicestatus";
const ROCKSTAR_SERVICES = [
  "Grand Theft Auto Online",
  "Red Dead Online",
  "Rockstar Games Launcher",
  "Rockstar Games Store",
  "Rockstar Games Social Club",
  "Authentication",
  "Online Services",
  "Cfx.re",
];

function rockstarStatusWord(window: string): "Operational" | "Limited" | "Down" | null {
  if (/outage|\bdown\b|unavailable/i.test(window)) return "Down";
  if (/limited|degraded|maintenance/i.test(window)) return "Limited";
  if (/operational/i.test(window)) return "Operational";
  return null;
}

// Tries to read Rockstar's official status page directly and store
// exactly what it says. Returns false when the page cannot be
// reached or no service line can be read — the caller then reports
// checked:false and the last real status stays on screen. Nothing
// here ever guesses a status.
async function tryRockstarCheck(): Promise<boolean> {
  let html: string;
  try {
    const res = await fetch(ROCKSTAR_STATUS_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return false;
    html = await res.text();
  } catch {
    return false;
  }
  if (html.length < 1000) return false;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
  const services: { name: string; status: string }[] = [];
  for (const name of ROCKSTAR_SERVICES) {
    const idx = text.indexOf(name);
    if (idx < 0) continue;
    const status = rockstarStatusWord(text.slice(idx, idx + 120));
    if (status && !services.some((s) => s.name === name)) services.push({ name, status });
  }
  if (services.length === 0) return false;
  const overall = services.some((s) => s.status === "Down")
    ? "down"
    : services.some((s) => s.status === "Limited")
      ? "issues"
      : "operational";
  await getDb()
    .insert(schema.rockstarStatusChecks)
    .values({ overall, servicesJson: JSON.stringify(services), sourceUrl: ROCKSTAR_STATUS_URL });
  return true;
}

export function createCtx(): Ctx {
  const db = getDb();
  const blobClient = getBlobs();
  return {
    slug: "vicesunshine",
    invocationId: crypto.randomUUID(),
    spaceDir: process.env.SPACE_DIR ?? process.cwd(),
    db: () => db as never,
    blobs: blobClient,
    agent: {
      async spawnTask(message: string) {
        // The only spawnTask caller left is the Rockstar status
        // checker (the email sender was replaced by Resend). Give
        // it a real direct read of Rockstar's page when possible.
        if (
          message.includes("support.rockstargames.com/servicestatus") ||
          message.includes("Rockstar's official service status page")
        ) {
          const ok = await tryRockstarCheck();
          if (ok) {
            const id = `rockstar-${Date.now()}`;
            return { ok: true, taskId: id, agentId: "standalone-rockstar-check", messageId: id };
          }
          return {
            ok: false,
            error:
              "Rockstar's service status page could not be read from this server (it is not reachable here). The last stored status stays on screen; nothing was guessed.",
          };
        }
        return { ok: false, error: "Background agent tasks are not available in the standalone build. Email codes are sent directly via Resend; the Rockstar status checker reads Rockstar's page directly when it can be reached." };
      },
      async send() {
        return { ok: false, error: "Background agent tasks are not available in the standalone build." };
      },
      async status(taskId: string) {
        return { taskId, status: "unavailable" };
      },
    },
    inference: {
      async complete<T extends z.ZodType>(prompt: string, options: { schema: T; timeout_secs?: number; images?: readonly { dataBase64: string; mimeType?: string; filename?: string }[] }): Promise<z.infer<T>> {
        // With an AI key configured, run it through the
        // OpenAI-compatible API — this powers Ask Vice's full
        // answers, the Database / bug / Easter egg extraction, and
        // (with images) real image moderation.
        const answered = await openAiCompatibleComplete(prompt, options);
        if (answered !== null) return answered;
        // No AI provider configured: image moderation only — the
        // schema is exactly {allowed: boolean, reason: string}.
        // With no AI provider, moderation is OFF and uploads are
        // allowed — see README. Anything else throws so callers
        // fall back (Ask Vice answers from the site's own data,
        // refreshBugs uses its title fallback, refreshDbEntries /
        // egg discovery add nothing this run).
        const shape = (options.schema as unknown as { _def?: { shape?: unknown; typeName?: string } })._def;
        if (shape?.typeName === "ZodObject") {
          const fields = typeof shape.shape === "function" ? (shape.shape as () => Record<string, z.ZodType>)() : (shape.shape as Record<string, z.ZodType>);
          const keys = Object.keys(fields ?? {});
          if (keys.length === 2 && keys.includes("allowed") && keys.includes("reason")) {
            return { allowed: true, reason: "" } as z.infer<T>;
          }
        }
        void prompt;
        throw new Error("AI inference is not configured in the standalone build (no OPENAI_API_KEY). Callers fall back to the site's own data.");
      },
    },
    tool: {
      async web_search(query: string) {
        return webSearch(query);
      },
      async generate_media() {
        throw new Error("Image generation is not available in the standalone build (no image provider configured — see README 'Pictures'). Existing pictures are unaffected.");
      },
    },
    emit() {},
    invalidateQueries() {},
  };
}
