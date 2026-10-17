import express, { Router } from "express";
import { and, eq } from "drizzle-orm";
import { Resend } from "resend";
import { fail, ok } from "@richtfest/shared";
import { receiveInboundEmail } from "@richtfest/projects/inbound-email";
import type { InboundEmailDeps } from "@richtfest/projects/deps";
import type { Database } from "./db/client";
import { memberships, users } from "./db/schema";
import { recordAudit } from "./audit";
import { fileStorage } from "./file-storage";
import { env } from "./env";

/** The provider side of inbound email: verify the webhook, fetch the original message. Replaceable in tests. */
export type InboundEmailProvider = {
  verify: (payload: string, headers: { id: string; timestamp: string; signature: string }) => { type: string; data: any };
  fetchRaw: (emailId: string) => Promise<{ raw: Uint8Array; recipients: string[]; receivedAt: string | null }>;
};

export const inboundEmailConfigured = () => Boolean(env.INBOUND_EMAIL_DOMAIN && env.RESEND_API_KEY && env.RESEND_WEBHOOK_SECRET);

export const resendInboundProvider = (): InboundEmailProvider => {
  const resend = new Resend(env.RESEND_API_KEY);
  return {
    verify: (payload, headers) => resend.webhooks.verify({ payload, headers, webhookSecret: env.RESEND_WEBHOOK_SECRET! }) as any,
    fetchRaw: async (emailId) => {
      const { data, error } = await resend.emails.receiving.get(emailId);
      if (error || !data) throw new Error(`Received email could not be read: ${error?.message ?? "missing"}`);
      if (!data.raw?.download_url) throw new Error("Received email has no original message to download");
      const response = await fetch(data.raw.download_url);
      if (!response.ok) throw new Error(`Original message download failed with ${response.status}`);
      return { raw: new Uint8Array(await response.arrayBuffer()), recipients: [...(data.received_for ?? []), ...data.to, ...(data.cc ?? [])], receivedAt: data.created_at ?? null };
    },
  };
};

export const inboundEmailDeps = (db: Database, domain: string): InboundEmailDeps => ({
  db, fileStorage, domain,
  audit: (tx, tenantId, action, entityType, entityId, metadata) => recordAudit(tx, null, tenantId, action, entityType, entityId, metadata, { actorType: "system" }),
  memberEmails: async (tenantId) => (await db.select({ email: users.email }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.status, "active")))).map(row => row.email),
});

/**
 * Public endpoint for the provider's email.received webhook. Only signed
 * requests are accepted; the payload carries metadata, so the original message
 * is fetched from the provider by id. Unknown addresses are acknowledged and
 * dropped; failures return 5xx so the provider retries.
 */
export function createInboundEmailWebhook(db: Database, options: { provider?: InboundEmailProvider; deps?: InboundEmailDeps } = {}) {
  const provider = options.provider ?? resendInboundProvider();
  const deps = options.deps ?? inboundEmailDeps(db, env.INBOUND_EMAIL_DOMAIN!);
  const router = Router();
  router.post("/api/inbound-email/resend", express.raw({ type: () => true, limit: "1mb" }), async (req, res) => {
    let event: { type: string; data: any };
    try {
      event = provider.verify(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "", {
        id: String(req.header("svix-id") ?? ""), timestamp: String(req.header("svix-timestamp") ?? ""), signature: String(req.header("svix-signature") ?? "") });
    } catch { return res.status(401).json(fail("invalid_signature", "Webhook signature is invalid")); }
    if (event.type !== "email.received" || typeof event.data?.email_id !== "string") return res.json(ok({ ignored: true }));
    try {
      const message = await provider.fetchRaw(event.data.email_id);
      const recipients = [...message.recipients, ...(event.data.received_for ?? []), ...(event.data.to ?? []), ...(event.data.cc ?? [])];
      const result = await receiveInboundEmail(deps, { provider: "resend", providerEmailId: event.data.email_id, recipients, raw: message.raw, receivedAt: message.receivedAt });
      return res.json(ok({ status: result.status }));
    } catch (error) {
      console.error("Inbound email could not be filed; the provider will retry", error instanceof Error ? error.message : error);
      return res.status(502).json(fail("inbound_email_failed", "The email could not be filed yet"));
    }
  });
  return router;
}
