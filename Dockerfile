# ViceSunshine standalone — Bun + React client + SQLite.
# Data lives on a Railway volume mounted at /data (see railway.toml):
# app.db and blobs/ must survive restarts, so they are NOT baked into
# the image as the live database. On first boot the container copies
# the seed app.db + blobs/ from /app/seed-data into /data if the
# volume is empty.
# Bun 1.4+ required: bun.lock is lockfileVersion 2, which Bun 1.3.x
# cannot parse ("Unknown lockfile version"). Pinned to 1.4.4, the
# version that generated this lockfile.
FROM oven/bun:1.4.4-slim
WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY vendor ./vendor
RUN bun install --frozen-lockfile

COPY client ./client
COPY server ./server
COPY drizzle ./drizzle
COPY space.json icon.webp ./
COPY app.db ./seed-data/
COPY blobs ./seed-data/blobs

RUN bun run build

# Do NOT set PORT here. Railway injects $PORT at runtime (currently
# 8080) and the server reads it — see server/standalone/server.ts.
# A hardcoded ENV PORT=3000 caused the 502 on Nov 20, 2026: the
# Railway domain's target port was set to 3000 while the server was
# actually listening on Railway's $PORT (8080), so the proxy
# forwarded to a port nothing listened on. The Railway domain target
# port must always match $PORT, never a hardcoded value.
CMD ["sh", "-c", "if [ ! -f /data/app.db ]; then echo 'Seeding /data from snapshot...'; cp -a /app/seed-data/app.db /data/app.db 2>/dev/null; cp -a /app/seed-data/blobs /data/blobs 2>/dev/null; fi; SPACE_DIR=/data bun run server/standalone/server.ts"]
