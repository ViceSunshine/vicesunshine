// Client bundle for the space.
//
// Bundling is owned by the SDK so every space produces an identical
// production-mode React bundle. See @hatch/space-sdk/build for the
// canonical Bun.build() configuration (entrypoint, outdir, NODE_ENV
// define, asset naming, tailwind plugin).

import { copyFile } from "node:fs/promises";
import { buildClient } from "@hatch/space-sdk/build";

await buildClient();

// ads.txt (Google AdSense authorized sellers file) must be served at the
// site root as a plain static file, next to the bundled index.html. The
// SDK bundler only emits the HTML entry and its hashed assets, so copy
// the source file into dist/ after the bundle is written.
await copyFile("./client/ads.txt", "./client/dist/ads.txt");
