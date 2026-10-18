import { Router, type Request } from "express";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { noiseInputKeys, noiseInputUnit, noiseSourceGaps, noiseSourceKindSchema, ok, requestableNoiseInputs, validateNoiseInput,
  type EnvironmentSurvey, type MappedNoiseSource, type NoiseInputValue, type NoiseRequestItem, type NoiseSource, type NoiseSourceKind } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { readProjectEnvironment } from "./environment";
import { inquiries, inquiryEntries, noiseSources, noiseSourceValues, projects } from "./schema";

/**
 * Exterior noise sources: the roads and railways a facade check accounts for,
 * with the inputs an emission calculation needs. Values are entered by people
 * (with their basis) or requested from the authority through an inquiry.
 * Nothing here calculates a level.
 */
const send = (res: any, status: number, body: any) => res.status(status).json(body);
const uuid = z.string().uuid();
const notFound = (res: any, message = "Noise source not found") => send(res, 404, { data: null, error: { code: "not_found" }, message });

const projectExists = async (d: AppDeps, projectId: string) =>
  !!(await d.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.tenantId, d.tenantId))).limit(1))[0];

/** Every source of a project with its current inputs; the latest version of each input wins, a null value clears it. */
export async function readNoiseSources(d: AppDeps, projectId: string): Promise<NoiseSource[]> {
  const rows = await d.db.select().from(noiseSources).where(and(eq(noiseSources.projectId, projectId), eq(noiseSources.tenantId, d.tenantId))).orderBy(asc(noiseSources.createdAt));
  if (!rows.length) return [];
  const values = await d.db.select().from(noiseSourceValues)
    .where(and(inArray(noiseSourceValues.sourceId, rows.map((row: any) => row.id)), eq(noiseSourceValues.tenantId, d.tenantId))).orderBy(desc(noiseSourceValues.version));
  const current = new Map<string, Record<string, NoiseInputValue>>();
  for (const value of values as any[]) {
    const inputs = current.get(value.sourceId) ?? {};
    if (!inputs[value.key]) inputs[value.key] = { value: value.value, unit: value.unit, basis: value.basis, version: value.version, enteredBy: value.createdBy, enteredAt: new Date(value.createdAt).toISOString() };
    current.set(value.sourceId, inputs);
  }
  return rows.map((row: any): NoiseSource => {
    const all = current.get(row.id) ?? {};
    const inputs = Object.fromEntries(Object.entries(all).filter(([, state]) => state.value !== null));
    return { id: row.id, kind: row.kind, name: row.name, mapped: row.mapped ?? null, inputs, missing: noiseSourceGaps(row.kind, inputs), inquiryId: row.inquiryId ?? null, createdAt: new Date(row.createdAt).toISOString() };
  });
}

const latestVersion = async (tx: any, sourceId: string, key: string) =>
  (await tx.select({ version: noiseSourceValues.version }).from(noiseSourceValues).where(and(eq(noiseSourceValues.sourceId, sourceId), eq(noiseSourceValues.key, key))).orderBy(desc(noiseSourceValues.version)).limit(1))[0]?.version ?? 0;

/** Mapped roads and railways of the project's current environment survey. */
const surveyMapped = (survey: EnvironmentSurvey | null) => {
  if (!survey) return null;
  const roads = survey.categories.find(item => item.category === "roads"), rail = survey.categories.find(item => item.category === "rail");
  return { fileId: survey.fileId, connectorVersion: survey.connectorVersion, retrievedAt: survey.retrievedAt, address: survey.site.address,
    roads: roads?.mapped ?? null, rail: rail?.mapped ?? null, incomplete: !!(roads?.coverage.truncated || rail?.coverage.truncated || roads?.status === "unavailable" || rail?.status === "unavailable"),
    // Neither list could be retrieved, e.g. a site outside every connected region; distinct from a survey made before lists were kept.
    unavailable: roads?.status === "unavailable" && rail?.status === "unavailable" && !roads.mapped && !rail.mapped };
};
const currentSurvey = async (d: AppDeps, projectId: string) => readProjectEnvironment(d, projectId).catch(() => null);

export function createNoiseSourcesRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();

  router.get("/projects/:projectId/noise-sources", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:read"); const projectId = uuid.parse(req.params.projectId);
      if (!(await projectExists(d, projectId))) return notFound(res, "Project not found");
      const [sources, survey] = await Promise.all([readNoiseSources(d, projectId), currentSurvey(d, projectId)]);
      return res.json(ok({ sources, survey: surveyMapped(survey) }));
    } catch (e) { return next(e); }
  });

  // Add a source by hand, or one of the current survey's mapped roads/railways (with a snapshot of what was mapped).
  router.post("/projects/:projectId/noise-sources", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(req.params.projectId);
      const input = z.union([
        z.object({ kind: noiseSourceKindSchema, name: z.string().trim().min(1).max(300) }).strict(),
        z.object({ mappedRef: z.string().min(1).max(400) }).strict(),
      ]).parse(req.body);
      if (!(await projectExists(d, projectId))) return notFound(res, "Project not found");
      let values: { kind: NoiseSourceKind; name: string; mappedRef: string | null; mapped: any };
      let imported: Array<{ key: string; value: number | string }> = [], importedFrom = "";
      if ("mappedRef" in input) {
        const survey = await currentSurvey(d, projectId), mapped = surveyMapped(survey);
        const item = [...(mapped?.roads ?? []), ...(mapped?.rail ?? [])].find((entry: MappedNoiseSource) => entry.ref === input.mappedRef);
        if (!survey || !item) return send(res, 409, { data: null, error: { code: "mapped_source_unavailable" }, message: "This mapped object is not part of the current environment survey; run it again" });
        const name = item.kind === "road" ? [item.designation, item.name].filter(Boolean).join(" ") || "Road"
          : [item.routeNumbers.length ? `Strecke ${item.routeNumbers.join(", ")}` : null, item.lines.join(", ") || null, item.name].filter(Boolean).join(" · ") || "Railway";
        values = { kind: item.kind, name: name.slice(0, 300), mappedRef: item.ref, mapped: { ...item, surveyFileId: survey.fileId, connectorVersion: survey.connectorVersion, retrievedAt: survey.retrievedAt } };
        // Published counts start the inputs as imported values; the basis names the source so they stay distinguishable from entered or confirmed ones.
        if (item.kind === "road" && item.traffic) {
          const { dailyTraffic, heavyVehicles, source, year } = item.traffic;
          importedFrom = source.includes(String(year)) ? source : `${source} (${year})`;
          imported = [{ key: "dailyTraffic", value: dailyTraffic }, { key: "trafficBasis", value: `${importedFrom}, segment nearest the site, imported from the mapped source` }];
          if (heavyVehicles !== null && dailyTraffic > 0) imported.push({ key: "heavyVehicleShare", value: Math.round((heavyVehicles / dailyTraffic) * 1000) / 10 });
        }
      } else values = { kind: input.kind, name: input.name, mappedRef: null, mapped: null };
      const created = await d.db.transaction(async (tx: any) => {
        const [row] = await tx.insert(noiseSources).values({ tenantId: d.tenantId, projectId, ...values, createdBy: d.actorId }).onConflictDoNothing().returning();
        if (!row) return null;
        await d.audit(tx, "projects.noise_source.created", "project_noise_source", row.id, { projectId, kind: row.kind, mappedRef: row.mappedRef });
        const basis = `Imported: ${importedFrom}`;
        for (const { key, value } of imported) {
          if (validateNoiseInput(row.kind, key, value)) continue;
          await tx.insert(noiseSourceValues).values({ tenantId: d.tenantId, sourceId: row.id, key, version: 1, value, unit: noiseInputUnit(row.kind, key), basis, createdBy: d.actorId });
          await d.audit(tx, "projects.noise_source.input_set", "project_noise_source", row.id, { projectId, key, version: 1, cleared: false, hasBasis: true, imported: true });
        }
        return row;
      });
      if (!created) return send(res, 409, { data: null, error: { code: "already_added" }, message: "This road or railway is already a noise source" });
      return send(res, 201, ok(created));
    } catch (e) { return next(e); }
  });

  router.delete("/projects/:projectId/noise-sources/:sourceId", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(req.params.projectId), sourceId = uuid.parse(req.params.sourceId);
      const removed = await d.db.transaction(async (tx: any) => {
        const [row] = await tx.delete(noiseSources).where(and(eq(noiseSources.id, sourceId), eq(noiseSources.projectId, projectId), eq(noiseSources.tenantId, d.tenantId))).returning();
        if (row) await d.audit(tx, "projects.noise_source.removed", "project_noise_source", sourceId, { projectId, kind: row.kind, name: row.name });
        return row;
      });
      if (!removed) return notFound(res);
      return res.json(ok({ id: sourceId }));
    } catch (e) { return next(e); }
  });

  // One input value. expectedVersion is the version the person saw (0 when empty); a newer one is a conflict.
  router.put("/projects/:projectId/noise-sources/:sourceId/inputs/:key", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(req.params.projectId), sourceId = uuid.parse(req.params.sourceId);
      const key = z.string().min(1).max(60).parse(req.params.key);
      const input = z.object({ value: z.union([z.string(), z.number(), z.null()]), basis: z.string().trim().max(300).nullable().optional(), expectedVersion: z.number().int().nonnegative() }).strict().parse(req.body);
      const result = await d.db.transaction(async (tx: any) => {
        const [source] = await tx.select().from(noiseSources).where(and(eq(noiseSources.id, sourceId), eq(noiseSources.projectId, projectId), eq(noiseSources.tenantId, d.tenantId))).for("update").limit(1);
        if (!source) return { missing: true };
        if (!noiseInputKeys(source.kind).includes(key)) return { invalid: `Unknown input ${key}` };
        const invalid = validateNoiseInput(source.kind, key, input.value);
        if (invalid) return { invalid };
        const latest = await latestVersion(tx, sourceId, key);
        if (latest !== input.expectedVersion) return { conflict: latest };
        const [row] = await tx.insert(noiseSourceValues).values({ tenantId: d.tenantId, sourceId, key, version: latest + 1, value: input.value, unit: input.value === null ? null : noiseInputUnit(source.kind, key),
          basis: input.basis?.trim() || null, createdBy: d.actorId }).returning();
        await tx.update(noiseSources).set({ updatedAt: new Date() }).where(eq(noiseSources.id, sourceId));
        await d.audit(tx, "projects.noise_source.input_set", "project_noise_source", sourceId, { projectId, key, version: row.version, cleared: input.value === null, hasBasis: !!row.basis });
        return { row };
      });
      if ((result as any).missing) return notFound(res);
      if ((result as any).invalid) return send(res, 422, { data: null, error: { code: "invalid_noise_input" }, message: (result as any).invalid });
      if ((result as any).conflict !== undefined) return send(res, 409, { data: { currentVersion: (result as any).conflict }, error: { code: "version_conflict" }, message: "Someone changed this value; reload before saving" });
      return res.json(ok((result as any).row));
    } catch (e) { return next(e); }
  });

  // Request the missing authority/operator inputs of the chosen sources as one inquiry; its progress follows the values entered later.
  router.post("/projects/:projectId/noise-sources/request", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(req.params.projectId);
      const input = z.object({ sourceIds: z.array(uuid).min(1).max(100), title: z.string().trim().min(1).max(300), counterpart: z.string().trim().min(1).max(200),
        request: z.object({ subject: z.string().trim().max(500).nullable().optional(), body: z.string().min(1).max(100_000) }).strict() }).strict().parse(req.body);
      const chosen = (await readNoiseSources(d, projectId)).filter(source => input.sourceIds.includes(source.id));
      const items: NoiseRequestItem[] = chosen.flatMap(source => {
        const fields = (requestableNoiseInputs[source.kind] as readonly string[]).filter(field => source.missing.includes(field));
        return fields.length ? [{ sourceId: source.id, kind: source.kind, name: source.name, fields }] : [];
      });
      if (!items.length) return send(res, 422, { data: null, error: { code: "nothing_to_request" }, message: "The chosen sources have no missing inputs to request" });
      const created = await d.db.transaction(async (tx: any) => {
        const [row] = await tx.insert(inquiries).values({ tenantId: d.tenantId, projectId, kind: "noise_data", title: input.title, counterpart: input.counterpart, status: "waiting", items, createdBy: d.actorId }).returning();
        await tx.insert(inquiryEntries).values({ tenantId: d.tenantId, inquiryId: row.id, kind: "request", direction: "outgoing", subject: input.request.subject ?? null, body: input.request.body, createdBy: d.actorId });
        await tx.update(noiseSources).set({ inquiryId: row.id, updatedAt: new Date() }).where(and(inArray(noiseSources.id, items.map(item => item.sourceId)), eq(noiseSources.tenantId, d.tenantId)));
        await d.audit(tx, "projects.inquiry.created", "project_inquiry", row.id, { projectId, kind: "noise_data", counterpart: input.counterpart, sources: items.length,
          fields: items.reduce((sum, item) => sum + item.fields.length, 0), requestSent: true });
        return row;
      });
      return send(res, 201, ok(created));
    } catch (e) { return next(e); }
  });

  return router;
}
