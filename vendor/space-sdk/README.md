# @hatch/space-sdk — standalone shim

This is NOT the Muse platform SDK. It is a small local replacement with
the same import surface, so the copied ViceSunshine source can run
outside Muse without changing its logic:

- `index.ts` — `defineAction`, `z`, `Ctx`, `ActionsModule`, blob/agent/
  inference/tool client types.
- `client.ts` — `createActionClient` (plain `POST ./actions`), the shared
  `spaceQueryClient`, `fileToBase64`, and `getSpaceViewer` (returns null:
  players are identified by `playerKey`, not by a Muse viewer).
- `fields.ts` — `actionFields()`. In Muse this was a build-time macro
  reading the Zod schemas; here it is a runtime Proxy returning
  `{name: <field>}`. The app only ever spreads these props onto inputs,
  so behaviour is identical, and the server still enforces the schemas.
- `build.ts` — `buildClient()`, the same Bun production bundle the SDK
  produced, minus the Muse build-driver guard.
