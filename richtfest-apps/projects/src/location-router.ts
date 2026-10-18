import { Router, type Request } from "express";
import { and, eq, sql, getTableColumns } from "drizzle-orm";
import { z } from "zod";
import { ok, projectAddressInput, locationMatchesAddress, aerialSourceFor, locationImageVersion, railNoiseAttribution, siteDxfBytes, siteGeoJson, siteExportFormats, AERIAL_HALF_WIDTH_M, RAIL_NOISE_HALF_WIDTH_M, type LocationState, type LocationContext } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { projectLocations as locations, projects, files, fileVersions } from "./schema";
import { validateLocationAddress } from "./location-context";
import { cachedLocationImage } from "./location-images";

/** Federal rail noise map (EBA), nationwide incl. the extended mapping; open WMS under dl-de/by-2-0. */
const EBA_RAIL_NOISE = "https://geoinformation.eisenbahn-bundesamt.de/wms/isophonen";
/** Official orthophoto WMS per register; both open (RLP dl-de/by-2-0, Berlin dl-de/zero-2-0). */
const AERIAL_WMS = {
  "rlp-dop20": { url: "https://geo4.service24.rlp.de/wms/rp_dop20.fcgi", layer: "rp_dop20" },
  "berlin-truedop": { url: "https://gdi.berlin.de/services/wms/truedop_2024", layer: "truedop_2024" },
} as const;

/** A fixed window around the site from a known WMS, never a caller-chosen URL or extent. */
async function sendWindow(req: Request, res: any, d: AppDeps, projectId: string, context: LocationContext, base: string, params: Record<string, string>, halfWidth: number, size: number, format: "image/png" | "image/jpeg", attribution: string) {
  res.setHeader("Cache-Control", "private, no-store");
  const version = z.string().optional().parse(req.query.v);
  if (version !== undefined && version !== locationImageVersion(context)) throw failure("Location changed; reload the site", 409, "location_changed");
  const url = new URL(base), [e, n] = context.origin, crs = context.crs ?? "EPSG:25833";
  for (const [key, value] of Object.entries({ SERVICE: "WMS", VERSION: "1.3.0", REQUEST: "GetMap", STYLES: "", CRS: crs, ...params,
    BBOX: [e - halfWidth, n - halfWidth, e + halfWidth, n + halfWidth].map(v => v.toFixed(1)).join(","), WIDTH: String(size), HEIGHT: String(size), FORMAT: format })) url.searchParams.set(key, value);
  const image = await cachedLocationImage(d, projectId, url, format, attribution).catch(error => {
    if (error.retryAt) res.setHeader("Retry-After", String(Math.max(1, Math.ceil((error.retryAt.getTime() - Date.now()) / 1000))));
    throw error;
  });
  res.setHeader("Content-Type", format);
  const maxAge = Math.max(0, Math.floor((image.freshUntil.getTime() - Date.now()) / 1000));
  // Legacy URLs and stale fallback must revalidate, never hide a moved site or a recovery.
  res.setHeader("Cache-Control", version !== undefined && !image.stale ? `private, max-age=${maxAge}` : "private, no-cache");
  res.setHeader("X-Imagery-Cache", image.stale ? "stale" : "fresh");
  res.setHeader("X-Imagery-Fetched-At", image.fetchedAt.toISOString());
  res.end(image.body);
}

const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const sceneInput = z.object({
  objects: z.array(z.object({
    id: z.string().min(1).max(200), kind: z.enum(["vehicle", "mass", "note", "ifc"]),
    label: z.string().max(500), position: vector,
    size: z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative(), z.number().finite().nonnegative()]),
    rotation: z.number().finite(), note: z.string().max(10000),
    source: z.object({ fileId: z.string().uuid(), version: z.number().int().positive() }).strict().optional(),
  }).strict().refine(item => (item.kind === "ifc") === Boolean(item.source), "IFC objects must reference a project source version")).max(1000).refine(items => new Set(items.map(i => i.id)).size === items.length, "Duplicate object IDs"),
  planningNotes: z.string().max(50000),
  measurements: z.array(z.object({
    id: z.string().uuid(), description: z.string().trim().max(500),
    purpose: z.enum(["general", "neighbor", "access", "road", "rail"]),
    points: z.tuple([vector, vector]),
    context: z.object({
      siteId: z.string().min(1).max(200), crs: z.enum(["EPSG:25832", "EPSG:25833"]),
      origin: z.tuple([z.number().finite(), z.number().finite()]), importedAt: z.string().min(1).max(100),
    }).strict(),
  }).strict()).max(1000).refine(items => new Set(items.map(i => i.id)).size === items.length, "Duplicate measurement IDs").optional(),
}).strict();
const failure = (message: string, status: number, code: string) => Object.assign(new Error(message), { status, code });
const { cloud: _cloud, ...stateColumns } = getTableColumns(locations);
export const locationState = (row?: Omit<typeof locations.$inferSelect, "cloud">): LocationState => ({
  revision: row?.revision ?? 0,
  scene: row?.scene ?? { objects: [], planningNotes: "" },
  context: row?.context ?? null,
  contextJob: { status: (row?.contextStatus ?? "idle") as LocationState["contextJob"]["status"], error: row?.contextError ?? null },
  lidarJob: { status: (row?.lidarStatus ?? "idle") as LocationState["lidarJob"]["status"], error: row?.lidarError ?? null },
});

export function createLocationRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  const scope = async (req: Request, write: boolean) => {
    const d = getDeps(req);
    d.requirePermission(write ? "projects:write" : "projects:read");
    const projectId = z.string().uuid().parse(req.params.projectId);
    const [project] = await d.db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.tenantId, d.tenantId))).limit(1);
    if (!project) throw failure("Project not found", 404, "not_found");
    return { d, projectId, address: projectAddressInput.parse(project), where: and(eq(locations.projectId, projectId), eq(locations.tenantId, d.tenantId)) };
  };
  router.get("/projects/:projectId/location", async (req, res, next) => {
    try {
      const { d, where } = await scope(req, false);
      const [row] = await d.db.select(stateColumns).from(locations).where(where).limit(1);
      const state = locationState(row);
      if (d.publicDataUpdates) state.availableContextUpdates = await d.publicDataUpdates(state.context?.publicReleases?.map(r => r.releaseId) ?? []);
      res.json(ok(state));
    } catch (error) { next(error); }
  });
  // 2D context only: DXF uses source UTM metres; RFC 7946 GeoJSON uses WGS84 lon/lat.
  router.get("/projects/:projectId/location/export", async (req, res, next) => {
    try {
      const format = z.enum(siteExportFormats).parse(req.query.format);
      const { d, where } = await scope(req, false);
      const [row] = await d.db.select(stateColumns).from(locations).where(where).limit(1);
      const state = locationState(row);
      if (!state.context) throw failure("Load the site context before exporting it", 409, "no_site_context");
      const name = `richtfest-site-2d-${format === "geojson" ? "wgs84" : state.context.crs ?? "EPSG:25833"}`.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
      res.setHeader("Cache-Control", "private, no-store");
      if (format === "geojson") {
        res.setHeader("Content-Type", "application/geo+json; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${name}.geojson"`);
        return res.end(siteGeoJson(state.context, state.scene));
      }
      res.setHeader("Content-Type", "application/dxf");
      res.setHeader("Content-Disposition", `attachment; filename="${name}.dxf"`);
      return res.end(Buffer.from(siteDxfBytes(state.context, state.scene)));
    } catch (error) { next(error); }
  });
  // A fixed window around the imported site, never a caller-chosen URL or extent.
  router.get("/projects/:projectId/location/rail-noise", async (req, res, next) => {
    try {
      const { d, where, projectId } = await scope(req, false);
      const [row] = await d.db.select({ context: locations.context }).from(locations).where(where).limit(1);
      const context = row?.context;
      if (!context) throw failure("Import the location first", 409, "location_missing");
      await sendWindow(req, res, d, projectId, context, EBA_RAIL_NOISE, { LAYERS: "isophonen_ek_lden", TRANSPARENT: "TRUE" }, RAIL_NOISE_HALF_WIDTH_M, 1024, "image/png", railNoiseAttribution);
    } catch (error) { next(error); }
  });
  router.get("/projects/:projectId/location/aerial/:extent", async (req, res, next) => {
    try {
      const { d, where, projectId } = await scope(req, false);
      const extent = z.enum(["near", "far"]).parse(req.params.extent);
      const [row] = await d.db.select({ context: locations.context }).from(locations).where(where).limit(1);
      const context = row?.context;
      if (!context) throw failure("Import the location first", 409, "location_missing");
      const source = aerialSourceFor(context);
      if (!source) throw failure("No aerial imagery for this site's register", 404, "aerial_unavailable");
      const wms = AERIAL_WMS[source.id];
      await sendWindow(req, res, d, projectId, context, wms.url, { LAYERS: wms.layer }, AERIAL_HALF_WIDTH_M[extent], 2048, "image/jpeg", source.attribution);
    } catch (error) { next(error); }
  });
  router.put("/projects/:projectId/location", async (req, res, next) => {
    try {
      const { d, projectId, where } = await scope(req, true);
      const input = z.object({ revision: z.number().int().nonnegative().max(2147483646), scene: sceneInput }).strict().parse(req.body);
      const row = await d.db.transaction(async (tx: any) => {
        for (const object of input.scene.objects) {
          if (!object.source) continue;
          const [source] = await tx.select({ id: files.id }).from(files)
            .innerJoin(fileVersions, eq(fileVersions.fileId, files.id))
            .where(and(eq(files.id, object.source.fileId), eq(files.projectId, projectId), eq(files.tenantId, d.tenantId), eq(fileVersions.tenantId, d.tenantId), eq(fileVersions.version, object.source.version), eq(fileVersions.status, "ready"))).limit(1);
          if (!source) throw failure("IFC source version not found in this project", 404, "not_found");
        }
        await tx.insert(locations).values({ projectId, tenantId: d.tenantId }).onConflictDoNothing();
        const [current] = await tx.select(stateColumns).from(locations).where(where).for("update");
        if (["queued", "running"].includes(current.contextStatus)) throw failure("Wait for the site import before saving scene changes", 409, "location_import_busy");
        // Older clients omit measurements; only an explicit array may replace them.
        const scene = { ...input.scene, ...(input.scene.measurements === undefined && current.scene.measurements ? { measurements: current.scene.measurements } : {}) };
        for (const measurement of scene.measurements ?? []) {
          const previous = current.scene.measurements?.find((item: { id: string }) => item.id === measurement.id);
          const reference = previous?.context ?? current.context;
          if (!reference || measurement.context.siteId !== reference.siteId || measurement.context.crs !== (reference.crs ?? "EPSG:25833") || measurement.context.importedAt !== reference.importedAt || measurement.context.origin.some((v: number, i: number) => v !== reference.origin[i])) {
            throw failure("Measurement reference changed; remeasure on the loaded site", 409, "measurement_context_changed");
          }
        }
        const [saved] = await tx.update(locations).set({ scene, revision: sql`${locations.revision} + 1`, updatedAt: new Date() }).where(and(where, eq(locations.revision, input.revision))).returning(stateColumns);
        if (!saved) throw failure("Location revision changed; reload before saving", 409, "revision_conflict");
        await d.audit(tx, "projects.location.saved", "project", projectId, { revision: saved.revision, measurementIds: (scene.measurements ?? []).map((item: { id: string }) => item.id) });
        return saved;
      });
      res.json(ok(locationState(row)));
    } catch (error) { next(error); }
  });
  for (const kind of ["context", "lidar"] as const) {
    router.post(`/projects/:projectId/location/${kind === "context" ? "import" : "lidar"}`, async (req, res, next) => {
      try {
        const { d, projectId, address, where } = await scope(req, true);
        const input = kind === "context"
          ? z.object({ revision: z.number().int().nonnegative().max(2147483646), refresh: z.boolean().default(false) }).strict().parse(req.body)
          : z.object({}).strict().parse(req.body ?? {});
        const refresh = "refresh" in input && input.refresh;
        if (refresh && !d.publicDataUpdates) throw failure("Public data refresh is not enabled", 409, "public_data_disabled");
        if (kind === "context") {
          try { validateLocationAddress(address); }
          catch (error) { throw failure((error as Error).message, 422, "location_address_invalid"); }
        }
        const row = await d.db.transaction(async (tx: any) => {
          await tx.insert(locations).values({ projectId, tenantId: d.tenantId }).onConflictDoNothing();
          const [current] = await tx.select(stateColumns).from(locations).where(where).for("update");
          if (kind === "lidar" && !current.context) throw failure("Import location context first", 409, "context_required");
          const status = kind === "context" ? current.contextStatus : current.lidarStatus;
          if (["queued", "running"].includes(status)) return current;
          if (status === "ready" && !refresh && (kind === "lidar" || (current.context && locationMatchesAddress(current.context, address)))) return current;
          if (kind === "context") {
            if (current.revision !== (input as { revision: number }).revision) throw failure("Location revision changed; reload before importing", 409, "revision_conflict");
            if (refresh) {
              if (!current.context?.publicReleases?.length || !locationMatchesAddress(current.context, address)) throw failure("Refresh requires a pinned context matching the saved project address", 409, "location_address_changed");
            } else if (current.scene.objects.length || current.scene.measurements?.length) throw failure("Existing objects and measurements are anchored to the imported site. Remove them and save before loading a different address", 409, "location_has_objects");
            if (["queued", "running"].includes(current.lidarStatus)) throw failure("Wait for the LiDAR import before changing sites", 409, "location_import_busy");
          }
          const [queued] = await tx.update(locations).set(kind === "context" ? refresh ? {
            requestedAddress: address, contextStatus: "queued", contextError: null, updatedAt: new Date(),
          } : {
            requestedAddress: address, contextStatus: "queued", contextError: null,
            context: null, cloud: null, lidarStatus: "idle", lidarError: null,
            revision: sql`${locations.revision} + 1`, leaseToken: null, leaseUntil: null, updatedAt: new Date(),
          } : { lidarStatus: "queued", lidarError: null, updatedAt: new Date() }).where(where).returning(stateColumns);
          await d.audit(tx, `projects.location.${kind}.queued`, "project", projectId, { revision: queued.revision, refresh });
          return queued;
        });
        res.status(202).json(ok(locationState(row)));
      } catch (error) { next(error); }
    });
  }
  router.get("/projects/:projectId/location/lidar", async (req, res, next) => {
    try {
      const { d, where } = await scope(req, false);
      const [row] = await d.db.select().from(locations).where(where).limit(1);
      if (!row?.cloud || row.lidarStatus !== "ready") throw failure("Point cloud is not ready; poll location state", 409, "lidar_not_ready");
      res.json(ok(row.cloud));
    } catch (error) { next(error); }
  });
  return router;
}
