import crypto from "node:crypto";
import { Router, type Request } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { agentProviderSchema, ok, type AgentProvider } from "@richtfest/shared";
import { aiConnections, osAgentSettings } from "./db/schema";
import type { Database } from "./db/client";
import { env } from "./env";
import { HttpError } from "./middleware/auth";
import { recordAudit } from "./audit";

const providers = agentProviderSchema;
const input = z.object({ apiKey: z.string().trim().min(10).max(500) });
const send = (res: any, status: number, body: any) =>
  res.status(status).json(body);
const keyMaterial = () => {
  if (!env.AI_CONNECTION_ENCRYPTION_KEY)
    throw new HttpError(
      503,
      "encryption_unconfigured",
      "AI connection encryption is not configured. Set AI_CONNECTION_ENCRYPTION_KEY before saving credentials.",
    );
  const raw = Buffer.from(env.AI_CONNECTION_ENCRYPTION_KEY, "base64");
  if (raw.length !== 32)
    throw new HttpError(
      503,
      "encryption_unconfigured",
      "AI_CONNECTION_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
    );
  return raw;
};
// Kept separate so the raw value exists only in this function scope and is never returned or logged.
const seal = (value: string) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyMaterial(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
};
export const isEncryptionConfigured = () => {
  try {
    keyMaterial();
    return true;
  } catch {
    return false;
  }
};

export const createAiConnectionsRouter = (db: Database) => {
  const router = Router();
  const actor = (req: Request) =>
    (req as any).actor as {
      id: string;
      tenantId: string;
      permissions: Set<string>;
    };
  router.get("/settings/ai-connections", async (req, res, next) => {
    try {
      const a = actor(req);
      const rows = await db
        .select({
          provider: aiConnections.provider,
          userId: aiConnections.userId,
          updatedAt: aiConnections.updatedAt,
        })
        .from(aiConnections)
        .where(eq(aiConnections.tenantId, a.tenantId));
      const result = providers.options.map((provider) => {
        const personal = rows.find(
          (r) => r.provider === provider && r.userId === a.id,
        );
        const workspace = rows.find(
          (r) => r.provider === provider && r.userId === null,
        );
        return {
          provider,
          workspace: {
            configured: Boolean(workspace),
            updatedAt: workspace?.updatedAt?.toISOString() ?? null,
          },
          personal: {
            configured: Boolean(personal),
            updatedAt: personal?.updatedAt?.toISOString() ?? null,
          },
          effectiveSource: personal
            ? "personal"
            : workspace
              ? "workspace"
              : null,
        };
      });
      return send(
        res,
        200,
        ok({
          encryptionConfigured: isEncryptionConfigured(),
          canManageWorkspace: a.permissions.has("access:manage"),
            selectedProvider: await getActiveProvider(db, a.tenantId),
          providers: result,
        }),
      );
    } catch (e) {
      next(e);
    }
  });
  router.get("/settings/agent-provider", async (req, res, next) => {
    try {
      const a = actor(req);
      return send(res, 200, ok({ provider: await getActiveProvider(db, a.tenantId), canManage: a.permissions.has("access:manage") }));
    } catch (e) { next(e); }
  });
  router.put(["/settings/agent-provider", "/agent/settings"], async (req, res, next) => {
    try {
      const a = actor(req);
      if (!a.permissions.has("access:manage")) throw new HttpError(403, "forbidden", "Workspace administration access is required.");
      const provider = providers.parse(req.body?.provider);
      const saved = await db.transaction(async (tx: any) => {
        const [row] = await tx.insert(osAgentSettings).values({ tenantId: a.tenantId, provider, updatedBy: a.id })
          .onConflictDoUpdate({ target: osAgentSettings.tenantId, set: { provider, updatedBy: a.id, updatedAt: new Date() } }).returning();
        await recordAudit(tx, a.id, a.tenantId, "settings.agent_provider.updated", "agent_settings", a.tenantId, { provider });
        return row;
      });
      return send(res, 200, ok({ provider: saved.provider }, "Active agent provider saved"));
    } catch (e) { next(e); }
  });
  const save =
    (scope: "workspace" | "personal") =>
    async (req: Request, res: any, next: any) => {
      try {
        const a = actor(req);
        const provider = providers.parse(req.params.provider);
        if (scope === "workspace" && !a.permissions.has("access:manage"))
          throw new HttpError(
            403,
            "forbidden",
            "Workspace AI connections require access:manage",
          );
        const { apiKey } = input.parse(req.body);
        const sealed = seal(apiKey);
        const userId = scope === "personal" ? a.id : null;
        const row = await db.transaction(async (tx: any) => {
          const existing = await tx
            .select({ id: aiConnections.id })
            .from(aiConnections)
            .where(
              and(
                eq(aiConnections.tenantId, a.tenantId),
                eq(aiConnections.provider, provider),
                userId
                  ? eq(aiConnections.userId, userId)
                  : isNull(aiConnections.userId),
              ),
            )
            .limit(1);
          const saved = existing[0]
            ? (
                await tx
                  .update(aiConnections)
                  .set({ ...sealed, updatedAt: new Date() })
                  .where(eq(aiConnections.id, existing[0].id))
                  .returning()
              )[0]
            : (
                await tx
                  .insert(aiConnections)
                  .values({
                    ...sealed,
                    tenantId: a.tenantId,
                    userId,
                    provider,
                    createdBy: a.id,
                  })
                  .returning()
              )[0];
          await recordAudit(
            tx,
            a.id,
            a.tenantId,
            `settings.ai_connection.${scope}.updated`,
            "ai_connection",
            saved.id,
            { provider, scope },
          );
          return saved;
        });
        return send(
          res,
          200,
          ok(
            { provider, source: scope, configured: true },
            "AI connection saved",
          ),
        );
      } catch (e) {
        next(e);
      }
    };
  router.put("/settings/ai-connections/:provider/workspace", save("workspace"));
  router.put("/settings/ai-connections/:provider/personal", save("personal"));
  const remove =
    (scope: "workspace" | "personal") =>
    async (req: Request, res: any, next: any) => {
      try {
        const a = actor(req);
        const provider = providers.parse(req.params.provider);
        if (scope === "workspace" && !a.permissions.has("access:manage"))
          throw new HttpError(
            403,
            "forbidden",
            "Workspace AI connections require access:manage",
          );
        const userId = scope === "personal" ? a.id : null;
        await db.transaction(async (tx: any) => {
          const row = await tx
            .select({ id: aiConnections.id })
            .from(aiConnections)
            .where(
              and(
                eq(aiConnections.tenantId, a.tenantId),
                eq(aiConnections.provider, provider),
                userId
                  ? eq(aiConnections.userId, userId)
                  : isNull(aiConnections.userId),
              ),
            )
            .limit(1);
          if (row[0]) {
            await tx
              .delete(aiConnections)
              .where(eq(aiConnections.id, row[0].id));
            await recordAudit(
              tx,
              a.id,
              a.tenantId,
              `settings.ai_connection.${scope}.deleted`,
              "ai_connection",
              row[0].id,
              { provider, scope },
            );
          }
        });
        return send(
          res,
          200,
          ok(
            { provider, source: scope, configured: false },
            "AI connection removed",
          ),
        );
      } catch (e) {
        next(e);
      }
    };
  router.delete(
    "/settings/ai-connections/:provider/workspace",
    remove("workspace"),
  );
  router.delete(
    "/settings/ai-connections/:provider/personal",
    remove("personal"),
  );
  return router;
};

export const configuredProvider = async (
  db: Database,
  tenantId: string,
  userId: string,
  requestedProvider?: AgentProvider,
) => {
  if (!isEncryptionConfigured()) return null;
  const rows = await db
    .select({ provider: aiConnections.provider, userId: aiConnections.userId })
    .from(aiConnections)
    .where(eq(aiConnections.tenantId, tenantId));
  for (const provider of requestedProvider
    ? [requestedProvider]
    : (["openai", "anthropic", "vercel"] as const)) {
    if (rows.some((row) => row.provider === provider && row.userId === userId))
      return { provider, source: "personal" as const };
    if (rows.some((row) => row.provider === provider && row.userId === null))
      return { provider, source: "workspace" as const };
  }
  return null;
};

// Only the server-side adapter receives plaintext credentials. Never expose this via a route.
export async function withProviderCredential<T>(
  db: Database,
  tenantId: string,
  userId: string,
  provider: AgentProvider,
  use: (key: string) => Promise<T>,
): Promise<T | null> {
  if (!isEncryptionConfigured()) return null;
  const rows = await db
    .select()
    .from(aiConnections)
    .where(
      and(
        eq(aiConnections.tenantId, tenantId),
        eq(aiConnections.provider, provider),
      ),
    );
  const row =
    rows.find((r) => r.userId === userId) ??
    rows.find((r) => r.userId === null);
  if (!row) return null;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    keyMaterial(),
    Buffer.from(row.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(row.authTag, "base64"));
  const key = Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return use(key);
}

export async function getActiveProvider(db: Database, tenantId: string): Promise<AgentProvider> {
  const [row] = await db.select({ provider: osAgentSettings.provider }).from(osAgentSettings).where(eq(osAgentSettings.tenantId, tenantId)).limit(1);
  return agentProviderSchema.parse(row?.provider ?? "openai");
}
