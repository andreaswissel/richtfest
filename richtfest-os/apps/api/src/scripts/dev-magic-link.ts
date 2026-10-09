import { desc, eq } from "drizzle-orm";
import { createDatabase } from "../db/client";
import { authDevOutbox } from "../db/schema";
import { env } from "../env";

const email = process.argv[2]?.trim().toLowerCase();
if (!email || env.NODE_ENV === "production" || env.RESEND_API_KEY || env.RESEND_FROM) {
  throw new Error("This helper is available only in local development without configured email delivery. Usage: bun run auth:dev-link email@example.com");
}

const { db, pool } = createDatabase(env.DATABASE_URL);
try {
  const response = await fetch(`${env.BETTER_AUTH_URL}/api/auth/sign-in/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, callbackURL: "/" }) });
  if (!response.ok) throw new Error(`Magic-link request failed with HTTP ${response.status}`);
  const [row] = await db.select({ url: authDevOutbox.url }).from(authDevOutbox).where(eq(authDevOutbox.email, email)).orderBy(desc(authDevOutbox.createdAt)).limit(1);
  if (!row) throw new Error("No local outbox message was created; confirm the identity is seeded or invited.");
  console.log(row.url);
} finally {
  await pool.end();
}
