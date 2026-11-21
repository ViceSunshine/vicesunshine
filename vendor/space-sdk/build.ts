// Standalone replacement for "@hatch/space-sdk/build" (buildClient).
// Same production client bundle as the Muse SDK produced: Bun.build
// of client/index.html into client/dist, NODE_ENV=production, hashed
// assets under assets/, with the bare-asset-URL re-prefix the SDK
// applied. The Muse guard (HATCH_SPACES_BUILD_DRIVER) is NOT here:
// this build is for the standalone Railway app, not the Muse artifact.
import { cp, exists, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import tailwindPlugin from "bun-plugin-tailwind";

const ENTRY = "./client/index.html";
const OUTDIR = "./client/dist";
const PDFJS_ASSET_ROOT = "./assets/pdfjs/";

export interface BuildClientOptions {}
export async function buildClient(_options: BuildClientOptions = {}): Promise<void> {
  if (typeof Bun === "undefined" || typeof Bun.build !== "function") {
    throw new Error("buildClient() must run under Bun");
  }
  const { rm } = await import("node:fs/promises");
  await rm(OUTDIR, { force: true, recursive: true });
  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir: OUTDIR,
    minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    naming: {
      asset: "assets/[name]-[hash].[ext]",
      chunk: "assets/[name]-[hash].[ext]",
      entry: "[name].[ext]",
    },
    plugins: [tailwindPlugin],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("buildClient() failed; see logged diagnostics");
  }
  const assetFiles = result.outputs.filter((o) => o.kind === "asset").map((o) => basename(o.path));
  let needsPdfjsAssets = false;
  for (const output of result.outputs) {
    if (!/\.(js|css|html)$/.test(output.path)) continue;
    let text = await output.text();
    needsPdfjsAssets ||= text.includes(PDFJS_ASSET_ROOT);
    let changed = false;
    for (const name of assetFiles) {
      const bare = `./${name}`;
      if (text.includes(bare)) {
        text = text.split(bare).join(`./assets/${name}`);
        changed = true;
      }
    }
    if (changed) await Bun.write(output.path, text);
  }
  if (needsPdfjsAssets && (await exists(join(import.meta.dir, "pdfjs-assets")))) {
    await cp(join(import.meta.dir, "pdfjs-assets"), join(OUTDIR, "assets", "pdfjs"), { recursive: true });
  }
  void readFile;
}
