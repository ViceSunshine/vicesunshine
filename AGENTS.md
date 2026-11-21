# AGENTS.md — ViceSunshine standalone repo

This is the STANDALONE copy of ViceSunshine (ported from the Muse
artifact `leonida-hub`), for running at vicesunshine.com on Railway.
It is NOT the Muse artifact: do not edit the Muse version from here,
and do not expect Muse build tools to work here.

- App code: `client/src/` (React, unchanged except the actionFields
  import) and `server/src/actions.ts` (unchanged except email delivery
  is now direct Resend — see `server/standalone/email.ts`).
- Platform shim: `vendor/space-sdk/` — a small local replacement for
  `@hatch/space-sdk` (defineAction, createActionClient, buildClient).
  Same import surface, plain HTTP + Bun SQLite underneath.
- Server: `server/standalone/server.ts` (`bun run start`),
  worker: `server/standalone/worker.ts` (`bun run worker`).
- Data: `app.db` + `blobs/` are the live snapshot copied from Muse.
  On Railway they live on a persistent volume mounted at /data.
- Never commit secrets. RESEND_API_KEY comes from Railway variables.
- Deploy steps, cron status, and what does NOT work yet: README.md.
