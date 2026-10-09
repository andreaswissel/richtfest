import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { Resend } from "resend";
import { authAccount, authPasskey, authRateLimit, authSession, authUser, authVerification } from "./db/auth-schema";
import { eq } from "drizzle-orm";
import { authDevOutbox, invitations, memberships, users } from "./db/schema";
import type { Database } from "./db/client";
import { env } from "./env";
import { createMagicLinkEmail } from "./magic-link-email";

export const createAuth = (db: Database) => betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema: { user: authUser, session: authSession, account: authAccount, verification: authVerification, rateLimit: authRateLimit, passkey: authPasskey } }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  trustedOrigins: [env.BETTER_AUTH_URL],
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
  } }), passkey({ rpID: new URL(env.BETTER_AUTH_URL).hostname, origin: env.BETTER_AUTH_URL })]
});
