import { Router, type Request } from "express";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import { ok, fail } from "@richtfest/shared";
import { customers, contacts } from "./schema";
import type { AppDeps } from "./deps";

type GetDeps = (req: Request) => AppDeps;
const customerInput = z.object({ name: z.string().trim().min(1).max(200), notes: z.string().max(5000).optional() });
const contactInput = z.object({ name: z.string().trim().min(1).max(200), email: z.string().email().optional(), phone: z.string().max(80).optional() });
const send = (res: any, status: number, body: any) => res.status(status).json(body);

export function createRouter(getDeps: GetDeps) {
  const router = Router();
  router.get("/customers", async (req, res, next) => { try { const d = getDeps(req); d.requirePermission("crm:read"); const rows = await d.db.select().from(customers).where(eq(customers.tenantId, d.tenantId)).orderBy(desc(customers.createdAt)); return send(res, 200, ok(rows)); } catch (e) { return next(e); } });
  router.post("/customers", async (req, res, next) => { try { const d = getDeps(req); d.requirePermission("crm:write"); const input = customerInput.parse(req.body); const row = await d.db.transaction(async (tx: any) => { const [created] = await tx.insert(customers).values({ ...input, tenantId: d.tenantId, createdBy: d.actorId }).returning(); await d.audit(tx, "crm.customer.created", "customer", created.id, { name: created.name }); return created; }); return send(res, 201, ok(row, "Customer created")); } catch (e) { return next(e); } });
  router.get("/customers/:customerId/contacts", async (req, res, next) => { try { const d = getDeps(req); d.requirePermission("crm:read"); const rows = await d.db.select().from(contacts).where(and(eq(contacts.tenantId, d.tenantId), eq(contacts.customerId, req.params.customerId))); return send(res, 200, ok(rows)); } catch (e) { return next(e); } });
  router.post("/customers/:customerId/contacts", async (req, res, next) => { try { const d = getDeps(req); d.requirePermission("crm:write"); const input = contactInput.parse(req.body); const [row] = await d.db.transaction(async (tx: any) => { const [created] = await tx.insert(contacts).values({ ...input, customerId: req.params.customerId, tenantId: d.tenantId }).returning(); await d.audit(tx, "crm.contact.created", "contact", created.id, { customerId: req.params.customerId }); return [created]; }); return send(res, 201, ok(row, "Contact created")); } catch (e) { return next(e); } });
  return router;
}
export const dashboardSummary = async (db: any, tenantId: string) => { const rows = await db.select({ id: customers.id, name: customers.name, createdAt: customers.createdAt }).from(customers).where(eq(customers.tenantId, tenantId)).orderBy(desc(customers.createdAt)); return { count: rows.length, customers: rows }; };
