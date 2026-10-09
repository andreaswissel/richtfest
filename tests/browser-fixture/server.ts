// Require a dedicated database variable so this harness cannot silently use
// the API's local or user-preview default database.
const databaseUrl = process.env.BROWSER_FIXTURE_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set BROWSER_FIXTURE_DATABASE_URL to a dedicated, migrated fixture database.",
  );
}
const databaseName = new URL(databaseUrl).pathname.slice(1).toLowerCase();
if (!/(fixture|browser)/.test(databaseName)) {
  throw new Error(
    "BROWSER_FIXTURE_DATABASE_URL must name an isolated database containing 'fixture' or 'browser'.",
  );
}

const encryptionKey = process.env.AI_CONNECTION_ENCRYPTION_KEY;
if (!encryptionKey || Buffer.from(encryptionKey, "base64").length !== 32) {
  throw new Error(
    "Set AI_CONNECTION_ENCRYPTION_KEY to base64 for exactly 32 bytes.",
  );
}

const port = Number(process.env.PORT ?? 4178);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer from 1 to 65535.");
}

process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = "development";
process.env.ALLOW_DEV_AUTH = "true";
process.env.BETTER_AUTH_URL ??= `http://127.0.0.1:${port}`;

const [{ createDatabase }, { createApp }, { createBrowserFixtureProviderFetch }] =
  await Promise.all([
    import("../../richtfest-os/apps/api/src/db/client"),
    import("../../richtfest-os/apps/api/src/server"),
    import("./provider"),
  ]);

const { db, pool } = createDatabase(databaseUrl);
const app = createApp(db, {
  allowDevAuth: true,
  providerFetch: createBrowserFixtureProviderFetch({
    chunkDelayMs: Number(process.env.BROWSER_FIXTURE_CHUNK_MS ?? 240),
    chunkSize: Number(process.env.BROWSER_FIXTURE_CHUNK_SIZE ?? 12),
  }),
});
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`Browser streaming fixture listening at http://127.0.0.1:${port}`);
  console.log("Sign in with a seeded fixture user, then configure an OpenAI placeholder key.");
});

const shutdown = () => {
  server.close(() => void pool.end().finally(() => process.exit(0)));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
