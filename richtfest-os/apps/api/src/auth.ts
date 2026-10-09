import { betterAuth } from "better-auth";
import { createAuthEndpoint, APIError, formCsrfMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { Resend } from "resend";
import { authAccount, authPasskey, authRateLimit, authSession, authUser, authVerification } from "./db/auth-schema";
import { and, eq, sql } from "drizzle-orm";
import { authDevOutbox, invitations, memberships, roles, users } from "./db/schema";
import type { Database } from "./db/client";
import { env } from "./env";
import { createMagicLinkEmail } from "./magic-link-email";
import { fail, ok } from "@richtfest/shared";
import { z } from "zod";

const createDevAuthPlugin = (db: Database, enabled: boolean) => ({
  id: "richtfest-dev-auth",
  endpoints: {
    devIdentities: createAuthEndpoint("/dev-identities", { method: "GET" }, async (ctx) => {
      if (!enabled) {
        return ctx.json(fail("not_found", "Development authentication is disabled"), { status: 404 });
      }
      const candidates = await db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .innerJoin(authUser, sql`${authUser.id} = CAST(${users.id} AS text)`)
        .innerJoin(memberships, eq(memberships.userId, users.id))
        .innerJoin(roles, eq(roles.id, memberships.roleId))
        .where(and(sql`${users.email} LIKE '%@richtfest.local'`, eq(memberships.status, "active")))
        .orderBy(users.name);
      const identities = [];
      for (const candidate of candidates) {
        const memberRows = await db
          .select({ tenantId: memberships.tenantId, status: memberships.status, role: roles.name })
          .from(memberships)
          .innerJoin(roles, eq(roles.id, memberships.roleId))
          .where(eq(memberships.userId, candidate.id));
        if (memberRows.length !== 1 || memberRows[0].status !== "active") continue;
        identities.push({ id: candidate.id, email: candidate.email, name: candidate.name, role: memberRows[0].role });
      }
      return ctx.json(ok({ available: true, identities }));
    }),
    devLogin: createAuthEndpoint("/dev-login", { method: "POST", use: [formCsrfMiddleware] }, async (ctx) => {
      if (!enabled) {
        return ctx.json(fail("not_found", "Development authentication is disabled"), { status: 404 });
      }
      const input = z.object({ email: z.string().email().transform((value) => value.toLowerCase()) }).parse(ctx.body);
      const [identity] = await db
        .select({ id: users.id })
        .from(users)
        .innerJoin(authUser, sql`${authUser.id} = CAST(${users.id} AS text)`)
        .where(and(
          eq(users.email, input.email),
          sql`${users.email} LIKE '%@richtfest.local'`,
        ))
        .limit(1);
      if (!identity) {
        return ctx.json(fail("unauthorized", "Development identity is unavailable"), { status: 401 });
      }
      const memberRows = await db
        .select({ status: memberships.status, role: roles.name })
        .from(memberships)
        .innerJoin(roles, eq(roles.id, memberships.roleId))
        .where(eq(memberships.userId, identity.id));
      if (memberRows.length !== 1 || memberRows[0].status !== "active") {
        return ctx.json(fail("unauthorized", "Development identity is unavailable"), { status: 401 });
      }
      const user = await ctx.context.internalAdapter.findUserById(identity.id);
      if (!user) {
        return ctx.json(fail("unauthorized", "Development identity is unavailable"), { status: 401 });
      }
      const session = await ctx.context.internalAdapter.createSession(user.id);
      if (!session) throw APIError.fromStatus(401, { code: "FAILED_TO_CREATE_SESSION", message: "Unable to create a session" });
      await setSessionCookie(ctx, { session, user });
      return ctx.json(ok({ signedIn: true }, "Signed in"));
    }),
  },
});

export const createAuth = (db: Database, options: { allowDevAuth?: boolean } = {}) => {
  const allowDevAuth = env.NODE_ENV !== "production" && options.allowDevAuth === true;
  return betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema: { user: authUser, session: authSession, account: authAccount, verification: authVerification, rateLimit: authRateLimit, passkey: authPasskey } }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  trustedOrigins: [
    env.BETTER_AUTH_URL,
    ...(env.NODE_ENV !== "production"
      ? ["http://localhost:5173", "http://127.0.0.1:5173"]
      : []),
  ],
  emailAndPassword: { enabled: true, disableSignUp: true },
  rateLimit: { enabled: true, storage: "database" } as any,
  plugins: [magicLink({ disableSignUp: true, storeToken: "hashed", rateLimit: { window: 60, max: 5 }, sendMagicLink: async ({ email, url, token }) => {
    const osUser = (await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0];
    // Keep the public sign-in response generic. Ineligible identities receive no
    // delivery and no token is exposed through application routes.
    if (!osUser) return;
    const memberRows = await db.select({ tenantId: memberships.tenantId, status: memberships.status }).from(memberships).where(eq(memberships.userId, osUser.id));
    const invitationRows = await db.select({ tenantId: invitations.tenantId, acceptedAt: invitations.acceptedAt, cancelledAt: invitations.cancelledAt, expiresAt: invitations.expiresAt }).from(invitations).where(eq(invitations.email, email));
    const hasInvitation = invitationRows.length > 0;
    const eligibleInvitation = invitationRows.some((row) => row.cancelledAt === null && (row.acceptedAt !== null || row.expiresAt > new Date()) && memberRows.some((member) => member.tenantId === row.tenantId && ["active", "invited"].includes(member.status)));
    if (hasInvitation && !eligibleInvitation) return;
    if (!memberRows.some((row) => row.status === "active") && !eligibleInvitation) return;
    const eligibleTenants = new Set(memberRows.filter((row) => ["active", "invited"].includes(row.status)).map((row) => row.tenantId));
    if (eligibleTenants.size !== 1) return;
    const tenantId = [...eligibleTenants][0];
    if (env.RESEND_API_KEY && env.RESEND_FROM) {
      const resend = new Resend(env.RESEND_API_KEY);
      const { error } = await resend.emails.send({ from: env.RESEND_FROM, to: email, ...createMagicLinkEmail(url) });
      if (error) throw new Error(`Magic-link delivery failed: ${error.message}`);
      return;
    }
    if (env.NODE_ENV === "production") return;
    await db.insert(authDevOutbox).values({ tenantId, email, url, token });
  } }), passkey({ rpID: new URL(env.BETTER_AUTH_URL).hostname, origin: env.BETTER_AUTH_URL }), createDevAuthPlugin(db, allowDevAuth)]
  });
};
