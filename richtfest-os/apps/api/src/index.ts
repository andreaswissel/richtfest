import { createServer } from "./server";
import { env } from "./env";
import { startSupervisorWorker } from "./supervisor-worker";
const { app, db, pool } = createServer();
const server = app.listen(env.PORT, () => console.log(`Richtfest API listening on ${env.PORT}`));
const worker = await startSupervisorWorker(db, pool);
async function shutdown() {
  server.close();
  await worker.stop();
  await pool.end();
}
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
