# Browser streaming fixture

This test-only harness serves the real API through `createApp` and injects a
synthetic, timed OpenAI-compatible SSE response. The injected provider makes no
network requests. It returns summary deltas, valid registered OpenUI, and a
structured draft artifact that the normal run path stores as proposed and
unapproved.

Use a dedicated PostgreSQL database for this fixture. Apply the normal API
migrations and seed the database before starting the server; the fixture never
migrates, seeds, or cleans up data itself. Do not point it at production or a
shared user-preview database.

```sh
export BROWSER_FIXTURE_DATABASE_URL='postgresql://…/richtfest_browser_fixture'
DATABASE_URL="$BROWSER_FIXTURE_DATABASE_URL" bun run db:migrate
DATABASE_URL="$BROWSER_FIXTURE_DATABASE_URL" bun run db:seed

AI_CONNECTION_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
PORT=4178 bun tests/browser-fixture/server.ts
```

The server binds only to `127.0.0.1` and defaults to port `4178`. Sign in with a
seeded development user using the normal magic-link flow, then open AI
connections and save any placeholder OpenAI key (for example
`sk-browser-fixture-placeholder`). The injected transport ignores credentials
and intercepts the provider call inside the real API; no provider service is
contacted.

The default stream sends 12-character output deltas every 240 ms, leaving time
to exercise scroll-away, text selection, and cancellation. Tune this with
`BROWSER_FIXTURE_CHUNK_MS` and `BROWSER_FIXTURE_CHUNK_SIZE`. Check that the
proposed artifact remains pending review.

Run the fixture transport self-test with:

```sh
bun test tests/browser-fixture/provider.test.ts
```
