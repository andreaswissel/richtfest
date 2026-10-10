import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { readFileSync } from "node:fs";
import { and, desc, eq, sql } from "drizzle-orm";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { fail, ok } from "@richtfest/shared";
import { createRouter as createCrmRouter } from "@richtfest/crm";
import { createRouter as createProjectsRouter } from "@richtfest/projects";
import { createRouter as createKnowledgeRouter } from "@richtfest/knowledge";
import { createRouter as createSupportRouter } from "@richtfest/support";
import { supportDeps } from "./support-host";
import { createDatabase, type Database } from "./db/client";
import { env } from "./env";
import { auditEvents, users } from "./db/schema";
import { authPasskey } from "./db/auth-schema";
import { dashboardSummary as crmDashboard } from "@richtfest/crm";
import { dashboardSummary as projectsDashboard } from "@richtfest/projects";
import { dashboardSummary as knowledgeDashboard } from "@richtfest/knowledge";
import { actorFor, HttpError, requireOsUse, requireSession } from "./middleware/auth";
import { crmDeps, knowledgeDeps, projectsDeps } from "./app-hosts";
import { createAiConnectionsRouter, configuredProvider, getActiveProvider } from "./ai-connections";
import { createAccessRouter } from "./access-routes";
import { createAgentPresetsRouter, listAgentPresets } from "./agent-presets";
import { createAuth } from "./auth";
import { recordAudit } from "./audit";

export const createApp = (db: Database, options: { allowDevAuth?: boolean; providerFetch?: import("./provider-runtime").ProviderFetch; supervisorRuntime?: Partial<Pick<import("@richtfest/knowledge/deps").AppDeps, "supervisorEnabled" | "executeSupervisor">> } = {}) => {
  const app = express();
  const allowDevAuth = env.NODE_ENV !== "production" && (options.allowDevAuth ?? env.ALLOW_DEV_AUTH);
  const auth = createAuth(db, { allowDevAuth });
  app.use(cookieParser());
  app.get("/health", (_req, res) => res.json(ok({ status: "ok" })));
  app.get("/api/health", (_req, res) => res.json(ok({ status: "ok" })));
  app.get("/api/auth/delivery-readiness", (_req, res) => res.json(ok({ configured: Boolean(env.RESEND_API_KEY && env.RESEND_FROM), mode: env.RESEND_API_KEY && env.RESEND_FROM ? "resend" : env.NODE_ENV === "production" ? "unconfigured" : "development_outbox" })));
  app.get("/api/auth/me", async (req, res, next) => { try { const current = await actorFor(db, auth, req); if (!current) return res.status(401).json(fail("unauthorized", "Sign in is required")); return res.json(ok({ id: current.id, email: current.email, name: current.name, tenantId: current.tenantId, uiDensity: current.uiDensity, language: current.language, theme: current.theme, user: { id: current.id, email: current.email, name: current.name, tenantId: current.tenantId, uiDensity: current.uiDensity, language: current.language, theme: current.theme } })); } catch (e) { next(e); } });
  app.use("/api/auth", (req, res, next) => { void toNodeHandler(auth)(req, res).catch(next); });
  app.use(express.json({ limit: "1mb" }));
  const docsDirectory = path.resolve(import.meta.dir, "../../docs/out");
  app.use(
    "/docs",
    requireSession(db, auth),
    requireOsUse,
    express.static(docsDirectory, { index: "index.html", redirect: true }),
    (_req, res) => res.status(404).json(fail("not_found", "Documentation page not found")),
  );
  app.use("/api", requireSession(db, auth));
  app.post("/api/auth/logout", async (req, res, next) => { try { await auth.api.signOut({ headers: fromNodeHeaders(req.headers) }); res.json(ok({ signedOut: true }, "Signed out")); } catch (e) { next(e); } });
  app.use("/api", requireOsUse);
  app.put("/api/account/preferences", async (req, res, next) => { try { const current = (req as any).actor; const input = z.object({ density: z.enum(["dense", "normal"]).optional(), language: z.enum(["en", "de"]).optional(), theme: z.enum(["light", "dark"]).optional() }).refine((value) => value.density !== undefined || value.language !== undefined || value.theme !== undefined, "At least one preference is required").parse(req.body); const [updated] = await db.update(users).set({ ...(input.density ? { uiDensity: input.density } : {}), ...(input.language ? { language: input.language } : {}), ...(input.theme ? { theme: input.theme } : {}) }).where(eq(users.id, current.id)).returning({ density: users.uiDensity, language: users.language, theme: users.theme }); await recordAudit(db, current.id, current.tenantId, "account.preferences.updated", "user", current.id, { density: updated.density, language: updated.language, theme: updated.theme }); return res.json(ok(updated, "Preferences saved")); } catch (e) { next(e); } });
  app.use("/api", createAccessRouter(db, auth, allowDevAuth));
  app.use("/api", createAiConnectionsRouter(db));
  app.use("/api", createAgentPresetsRouter(db));
  app.get("/api/account/security", async (req, res, next) => { try { const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }); if (!session?.user) return res.status(401).json(fail("unauthorized", "Sign in is required")); const accounts = await auth.api.listUserAccounts({ headers: fromNodeHeaders(req.headers) }); const sessions = await auth.api.listSessions({ headers: fromNodeHeaders(req.headers) }); const createdAt = new Date(session.session.createdAt).getTime(); const recentlyVerified = Number.isFinite(createdAt) && Date.now() - createdAt <= 15 * 60 * 1000; const passkeys = await db.select({ id: authPasskey.id, name: authPasskey.name, deviceType: authPasskey.deviceType, backedUp: authPasskey.backedUp, createdAt: authPasskey.createdAt }).from(authPasskey).where(eq(authPasskey.userId, session.user.id)); return res.json(ok({ emailVerified: session.user.emailVerified, recentlyVerified, passwordConfigured: accounts.some((account: any) => account.providerId === "credential"), passkeys, sessions: sessions ?? [] })); } catch (e) { next(e); } });
  app.post("/api/account/security/password", async (req, res, next) => { try { const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }); const createdAt = session ? new Date(session.session.createdAt).getTime() : NaN; const recentlyVerified = Number.isFinite(createdAt) && Date.now() - createdAt <= 15 * 60 * 1000; if (!session?.user || !session.user.emailVerified || !recentlyVerified) return res.status(403).json(fail("recent_session_required", "A recently verified email session is required")); const accounts = await auth.api.listUserAccounts({ headers: fromNodeHeaders(req.headers) }); if (accounts.some((account: any) => account.providerId === "credential")) return res.status(409).json(fail("password_already_configured", "A password is already configured")); const input = z.object({ newPassword: z.string().min(12).max(200) }).parse(req.body); await auth.api.setPassword({ headers: fromNodeHeaders(req.headers), body: { newPassword: input.newPassword } }); return res.json(ok({ passwordConfigured: true }, "Password saved")); } catch (e) { next(e); } });
  app.get("/api/activity", async (req, res, next) => { try { const tenantId = (req as any).actor.tenantId; const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50) || 50)); const conditions: any[] = [eq(auditEvents.tenantId, tenantId)]; if (typeof req.query.entityType === "string") conditions.push(eq(auditEvents.entityType, req.query.entityType)); if (typeof req.query.entityId === "string") conditions.push(eq(auditEvents.entityId, req.query.entityId)); if (typeof req.query.projectId === "string") conditions.push(sql`${auditEvents.metadata}->>'projectId' = ${req.query.projectId}`); if (typeof req.query.cursor === "string") conditions.push(sql`${auditEvents.createdAt} < ${new Date(req.query.cursor)}`); const rows = await db.select().from(auditEvents).where(and(...conditions)).orderBy(desc(auditEvents.createdAt)).limit(limit + 1); const page = rows.slice(0, limit); res.json(ok({ items: page.map((row) => ({ id: row.id, actorType: row.actorType, action: row.action, entityType: row.entityType, entityId: row.entityId, correlationId: row.correlationId, runId: row.runId, summary: typeof row.metadata === "object" && row.metadata ? (row.metadata as any).summary ?? null : null, createdAt: row.createdAt })), nextCursor: rows.length > limit ? page.at(-1)?.createdAt?.toISOString() ?? null : null })); } catch (e) { next(e); } });
  app.get("/api/dashboard", async (req, res, next) => { try { const tenantId = (req as any).actor.tenantId; const [crm, project, knowledge] = await Promise.all([crmDashboard(db, tenantId), projectsDashboard(db, tenantId), knowledgeDashboard(db, tenantId)]); res.json(ok({ customerCount: crm.count, projectCount: project.count, tenantId, projects: project.projects, tasks: knowledge.tasks, pendingDrafts: knowledge.pendingDrafts, missingInformation: [] })); } catch (e) { next(e); } });
  app.use("/api/crm", createCrmRouter((req) => crmDeps(db, req)));
  app.use("/api", createProjectsRouter((req) => projectsDeps(db, req)));
  app.use("/api/knowledge", createKnowledgeRouter((req) => knowledgeDeps(db, req, options.providerFetch, options.supervisorRuntime)));
  app.use("/api/support", createSupportRouter((req) => supportDeps(db, req, options.providerFetch)));
  app.get("/api/agent/readiness", async (req, res, next) => {
    try {
      const actor = (req as any).actor;
      const provider = await getActiveProvider(db, actor.tenantId);
      const selected = await configuredProvider(db, actor.tenantId, actor.id, provider);
      const credentialsConfigured = Boolean(selected);
      const enabled = options.supervisorRuntime?.supervisorEnabled ?? env.AGENT_SUPERVISOR_ENABLED;
      const presets = provider ? await listAgentPresets(db, actor.tenantId, provider) : [];
      const modelConfigured = presets.some((preset) => preset.configured);
      const executionAvailable = credentialsConfigured && modelConfigured;
      res.json(ok({
        configured: executionAvailable, credentialsConfigured, executionAvailable,
        status: !credentialsConfigured ? "unconfigured" : modelConfigured ? "configured" : "model_unconfigured", provider, source: selected?.source ?? null,
        supervisor: { enabled, presets },
        action: !credentialsConfigured ? `Configure a personal or workspace ${provider} connection` : !modelConfigured ? "Configure at least one model preset for the selected provider" : "Use the project workspace to start a scoped agent run",
      }));
    } catch (e) { next(e); }
  });
  app.post("/api/agent/run", async (req, res, next) => { try { const actor = (req as any).actor; const provider = await getActiveProvider(db, actor.tenantId); const selected = await configuredProvider(db, actor.tenantId, actor.id, provider); if (!selected) return res.status(503).json(fail("agent_unconfigured", `No configured ${provider} connection is available for this user.`)); return res.status(400).json(fail("project_context_required", "Start a scoped run at /api/knowledge/runs with an explicit projectId.")); } catch (e) { next(e); } });
  app.use("/api", (_req, res) => res.status(404).json(fail("not_found", "Route not found")));
  if (env.NODE_ENV === "production") {
    const landingDirectory = path.resolve(import.meta.dir, "../../../../richtfest-landing");
    // Keep a shareable Railway preview URL while the custom root domain is being configured.
    app.use("/landing", express.static(landingDirectory, { index: "index.html", redirect: true }));
    app.get("/", (req, res, next) => {
      if (["richtfest.ai", "richtfest.si", "www.richtfest.si", "richtfest.andreaswissel.com"].includes(req.hostname.toLowerCase())) {
        return res.sendFile(path.join(landingDirectory, "index.html"));
      }
      return next();
    });
    const webDirectory = path.resolve(import.meta.dir, "../../web/dist");
    const webHtml = readFileSync(path.join(webDirectory, "index.html"), "utf8")
      .replaceAll("__PUBLIC_ORIGIN__", new URL(env.BETTER_AUTH_URL).origin);
    app.get("/index.html", (_req, res) => res.set("Cache-Control", "no-store").type("html").send(webHtml));
    app.use(express.static(webDirectory, { index: false }));
    // A removed deployment chunk is not an app route. Never return HTML as JS.
    app.use("/assets", (_req, res) => res.status(404).set("Cache-Control", "no-store").end());
    app.get("*", (_req, res) => res.set("Cache-Control", "no-store").type("html").send(webHtml));
  }
  app.use((_req, res) => res.status(404).json(fail("not_found", "Route not found")));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => { if (error instanceof z.ZodError) return res.status(400).json(fail("validation_error", "Request validation failed", error.flatten())); if (error instanceof HttpError || (error as any)?.status) { const e = error as any; return res.status(e.status ?? 500).json(fail(e.code ?? "request_error", e.message)); } console.error(error); return res.status(500).json(fail("internal_error", "An unexpected error occurred")); });
  return app;
};
export const createServer = () => { const { db, pool } = createDatabase(env.DATABASE_URL); return { app: createApp(db), db, pool }; };
