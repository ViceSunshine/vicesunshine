// Migration-on-boot for the standalone server.
//
// Runs drizzle/*.sql files in journal order against the app database
// (the same path ctx.ts getDb() opens: DATABASE_PATH, else
// SPACE_DIR/app.db, else ./app.db) and tracks applied migrations in
// the __drizzle_migrations table using drizzle's own convention:
//   hash       = sha256 of the migration file contents
//   created_at = the journal entry's `when` timestamp
// This is the same table and the same hashes the Muse platform wrote
// for migrations 0001-0065, so a database that already has them is
// correctly recognised and only the new files are applied.
//
// Guarantees:
// - Idempotent: a migration whose hash is already recorded is skipped.
// - One transaction per migration file: a failure rolls that file
//   back and aborts the whole run — never a half-applied migration.
// - Never drops data beyond what the migration file itself says
//   (the runner only executes the files; it adds no statements).
// - Logs every migration it applies; logs "up to date" when there
//   is nothing to do. Any failure throws, and the caller must abort
//   startup loudly instead of serving code against the wrong schema.
//
// Runnable directly, too: `DATABASE_PATH=/tmp/test.db bun run
// server/standalone/migrate.ts` (exits 1 on failure).
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";

// Drizzle's own tracking table, verbatim from drizzle-orm's migrator.
const MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
				id SERIAL PRIMARY KEY,
				hash text NOT NULL,
				created_at numeric
			)`;

// Same path logic as ctx.ts getDb() — keep the two in sync.
export function dbPath(): string {
  return process.env.DATABASE_PATH ?? `${process.env.SPACE_DIR ?? process.cwd()}/app.db`;
}

export function migrationsDir(): string {
  return new URL("../../drizzle", import.meta.url).pathname;
}

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

export function runMigrations(dbPathOverride?: string, dirOverride?: string): string[] {
  const path = dbPathOverride ?? dbPath();
  const dir = dirOverride ?? migrationsDir();
  const journal = JSON.parse(fs.readFileSync(`${dir}/meta/_journal.json`, "utf8")) as {
    entries: JournalEntry[];
  };
  const db = new Database(path, { readonly: false });
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    db.exec(MIGRATIONS_TABLE_SQL);
    const applied = new Set<string>(
      (db.query(`SELECT hash FROM "__drizzle_migrations"`).all() as { hash: string }[]).map(
        (r) => r.hash,
      ),
    );
    const newlyApplied: string[] = [];
    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
    for (const entry of entries) {
      const sqlText = fs.readFileSync(`${dir}/${entry.tag}.sql`, "utf8");
      const hash = createHash("sha256").update(sqlText).digest("hex");
      if (applied.has(hash)) continue;
      const statements = sqlText
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);
      const apply = db.transaction(() => {
        for (const stmt of statements) db.exec(stmt);
        db.query(`INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)`).run(
          hash,
          entry.when,
        );
      });
      apply();
      applied.add(hash);
      newlyApplied.push(entry.tag);
      console.log(`[migrations] applied ${entry.tag}`);
    }
    if (newlyApplied.length === 0) console.log("[migrations] database is up to date");
    return newlyApplied;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  try {
    runMigrations();
  } catch (e) {
    console.error("[migrations] FAILED — aborting:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
