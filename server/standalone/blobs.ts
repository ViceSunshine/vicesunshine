// Blob storage for the standalone build, backed by the copied Muse
// blob store: blobs/index.sqlite (key -> content_type, size, etag,
// object_id) plus blobs/objects/<first-2-hex>/<object_id> files.
// getUrl returns a same-origin /blobs/<key> URL, served by
// server/standalone/server.ts from the objects directory.
// New uploads get a fresh object_id = SHA-256 of the bytes, exactly
// like the Muse store's hash-prefixed layout.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { BlobClient, BlobMetadata, BlobPutData, BlobPutOptions, BlobUrlOptions } from "@hatch/space-sdk";

export class FileBlobClient implements BlobClient {
  private db: Database;
  private objectsDir: string;

  constructor(spaceDir: string) {
    this.objectsDir = join(spaceDir, "blobs", "objects");
    this.db = new Database(join(spaceDir, "blobs", "index.sqlite"), { readonly: false });
    this.db.exec("PRAGMA journal_mode=WAL;");
  }

  private objectPath(objectId: string): string {
    return join(this.objectsDir, objectId.slice(0, 2), objectId);
  }

  private row(key: string): { key: string; content_type: string; size_bytes: number; etag: string; visibility: string; created_at_ms: number; updated_at_ms: number; object_id: string | null } | undefined {
    return this.db.query("SELECT * FROM blobs WHERE key = ?").get(key) as never;
  }

  async put(key: string, data: BlobPutData, options?: BlobPutOptions): Promise<void> {
    const bytes = typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data instanceof Blob
          ? new Uint8Array(await data.arrayBuffer())
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const objectId = createHash("sha256").update(bytes).digest("hex");
    const path = this.objectPath(objectId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    const now = Date.now();
    const existing = this.row(key);
    this.db.run(
      `INSERT INTO blobs (key, content_type, size_bytes, etag, visibility, created_at_ms, updated_at_ms, object_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET content_type=excluded.content_type, size_bytes=excluded.size_bytes,
         etag=excluded.etag, visibility=excluded.visibility, updated_at_ms=excluded.updated_at_ms,
         object_id=excluded.object_id`,
      [key, options?.contentType ?? "application/octet-stream", bytes.length, objectId, options?.public ? "public" : "private", existing?.created_at_ms ?? now, now, objectId],
    );
  }

  async getUrl(key: string, _options?: BlobUrlOptions): Promise<string> {
    const row = this.row(key);
    if (!row || !row.object_id) throw new Error(`Blob not found: ${key}`);
    if (!existsSync(this.objectPath(row.object_id))) throw new Error(`Blob file missing: ${key}`);
    return `/blobs/${encodeURIComponent(key)}`;
  }

  /** Resolve a key to a file on disk for the HTTP server. Returns null when missing. */
  fileFor(key: string): { path: string; contentType: string; size: number } | null {
    const row = this.row(decodeURIComponent(key));
    if (!row || !row.object_id) return null;
    const path = this.objectPath(row.object_id);
    if (!existsSync(path)) return null;
    return { path, contentType: row.content_type, size: row.size_bytes };
  }

  async delete(key: string): Promise<void> {
    const row = this.row(key);
    if (row?.object_id) {
      const path = this.objectPath(row.object_id);
      if (existsSync(path)) rmSync(path);
    }
    this.db.run("DELETE FROM blobs WHERE key = ?", [key]);
  }

  async head(key: string): Promise<BlobMetadata | null> {
    const row = this.row(key);
    if (!row) return null;
    return { key: row.key, contentType: row.content_type, size: row.size_bytes, sizeBytes: row.size_bytes, etag: row.etag, visibility: row.visibility as "private" | "public", createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms, public: row.visibility === "public" };
  }

  async list(prefix = ""): Promise<BlobMetadata[]> {
    const rows = this.db.query("SELECT * FROM blobs WHERE key LIKE ? ORDER BY key").all(`${prefix}%`) as never[];
    return (rows as ReturnType<FileBlobClient["row"]>[]).map((r) => ({
      key: r!.key, contentType: r!.content_type, size: r!.size_bytes, sizeBytes: r!.size_bytes, etag: r!.etag,
      visibility: r!.visibility as "private" | "public", createdAtMs: r!.created_at_ms, updatedAtMs: r!.updated_at_ms, public: r!.visibility === "public",
    }));
  }
}
