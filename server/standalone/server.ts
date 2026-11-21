// Standalone HTTP server for ViceSunshine.
// Serves the built React client (client/dist) and dispatches
// POST ./actions to the copied actions module, using the standalone
// Ctx from ./ctx.ts. No Muse runtime involved.
//
// Routes:
//   POST /actions        {action, args} -> {data} | {error}
//   GET  /blobs/<key>    blob file from the copied blob store
//   GET  /health         {"ok":true} for Railway health checks
//   GET  /*              client/dist static files, SPA fallback to index.html
import { isAction } from "@hatch/space-sdk";
import { createCtx, getBlobs } from "./ctx";
import { runMigrations } from "./migrate";

// Apply pending database migrations BEFORE anything touches the DB:
// the code may need schema from migrations newer than the database
// (on Railway the volume DB predates the deployed code). A failure
// aborts startup loudly instead of serving broken code.
try {
  runMigrations();
} catch (e) {
  console.error("[migrations] FAILED — server will not start:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const actions = await import("../src/actions");
const defs = (actions as Record<string, unknown>).Actions as Record<string, unknown> | undefined;
if (!defs || typeof defs !== "object") throw new Error("server/src/actions.ts did not export the named Actions module");

// Built client lives in the app directory (/app/client/dist in the
// Docker image), NOT under SPACE_DIR. SPACE_DIR is the Railway data
// volume (/data) and holds only app.db + blobs — it never contains
// client/dist. Using SPACE_DIR here made the server look in
// /data/client/dist and always answer "Client not built" on Railway.
const DIST = `${process.cwd()}/client/dist`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/health") return json({ ok: true });
      if (url.pathname === "/actions" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { action?: unknown; args?: unknown };
        const name = typeof body.action === "string" ? body.action : "";
        const def = defs[name];
        if (!isAction(def)) return json({ error: `Unknown action: ${name}` }, 400);
        try {
          const args = def.request.parse(body.args ?? {});
          const ctx = createCtx();
          const result = await def.handler(ctx, args);
          const data = def.response.parse(result);
          return json({ data });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Zod validation errors come back as a plain readable message.
          return json({ error: msg }, 400);
        }
      }
      if (url.pathname.startsWith("/blobs/")) {
        const key = url.pathname.slice("/blobs/".length);
        const file = getBlobs().fileFor(key);
        if (!file) return new Response("Blob not found", { status: 404 });
        return new Response(Bun.file(file.path), {
          headers: { "content-type": file.contentType, "cache-control": "public, max-age=31536000, immutable" },
        });
      }
      // Static client files, SPA fallback.
      let path = `${DIST}${decodeURIComponent(url.pathname)}`;
      if (url.pathname === "/" || url.pathname === "") path = `${DIST}/index.html`;
      const file = Bun.file(path);
      if (await file.exists()) {
        return new Response(file, { headers: { "cache-control": url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=60" } });
      }
      const index = Bun.file(`${DIST}/index.html`);
      if (await index.exists()) return new Response(index);
      return new Response("Client not built — run `bun run build` first.", { status: 500 });
    } catch (e) {
      console.error(e);
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  },
});

console.log(`ViceSunshine standalone server listening on http://0.0.0.0:${server.port}`);
