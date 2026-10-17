import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, desc, eq, sql } from "drizzle-orm";
import { environmentSurveySchema, locationMatchesAddress, projectAddressInput, type EnvironmentSurvey } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { files, fileVersions, projects, projectLocations } from "./schema";
import { groupMappedSources, hessenAttribution, hessenMappedAxis, HESSEN_ATKIS, readGmlFeatures, resolveHessenAddress, rlpMappedAxis, type GmlFeature, type MappedAxis } from "./noise-geodata";

/** Sites with an imported location (Rheinland-Pfalz) use the RLP connector; other addresses are resolved in Hessen. */
const CONNECTOR = "rlp-basis-dlm-framap-spatial-v5";
const HESSEN_CONNECTOR = "he-basis-dlm-hako-framap-v1";
const LIMIT = 500;
const ROAD_LIMIT = 2000;
const BASE = "https://www.geoportal.rlp.de/spatial-objects/606/collections/vermkv:";
const FLIGHTS = "https://framap.fraport.de/framap/main/r/isfl/go";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = (code: string, message = code) => Object.assign(new Error(message), { code, status: 409 });
type Category = EnvironmentSurvey["categories"][number];
type RawResponse = { url: string; retrievedAt: string; sha256: string; body: string };
type Scope =
  | { kind: "location"; site: { siteId: string; address: string; latitude: number; longitude: number }; revision: number; cacheKey: string }
  | { kind: "address"; address: ReturnType<typeof projectAddressInput.parse>; revision: number; cacheKey: string };

async function scope(d: AppDeps, projectId: string, db = d.db): Promise<Scope> {
  d.requirePermission("projects:read");
  const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.tenantId, d.tenantId))).limit(1);
  const [location] = await db.select().from(projectLocations).where(and(eq(projectLocations.projectId, projectId), eq(projectLocations.tenantId, d.tenantId))).limit(1);
  if (!project) throw Object.assign(new Error("Project not found"), { status: 404 });
  const address = projectAddressInput.parse(project);
  const context = location?.context;
  if (context && location.contextStatus === "ready" && locationMatchesAddress(context, address)) {
    if (!Number.isFinite(context.latitude) || !Number.isFinite(context.longitude)) throw fail("environment_coordinates_required");
    const cacheKey = hash(JSON.stringify({ connector: CONNECTOR, address, siteId: context.siteId, latitude: context.latitude, longitude: context.longitude }));
    return { kind: "location", site: { siteId: context.siteId, address: context.address, latitude: context.latitude, longitude: context.longitude }, revision: location.revision, cacheKey };
  }
  // Without an imported location the site point comes from Hessen's official house coordinates at research time.
  if (!address.street || !address.city) throw fail("environment_current_location_required");
  return { kind: "address", address, revision: location?.revision ?? 0, cacheKey: hash(JSON.stringify({ connector: HESSEN_CONNECTOR, address })) };
}
async function cached(d: AppDeps, projectId: string, cacheKey: string, db = d.db): Promise<EnvironmentSurvey | null> {
  const rows = await db.select({ metadata: fileVersions.sourceMetadata }).from(files).innerJoin(fileVersions, eq(files.id, fileVersions.fileId)).where(and(eq(files.tenantId, d.tenantId), eq(files.projectId, projectId), eq(files.sourceType, "environment_research"), eq(files.purpose, "project_evidence"), eq(fileVersions.tenantId, d.tenantId), eq(fileVersions.status, "ready"), sql`${fileVersions.sourceMetadata}->>'environmentCacheKey' = ${cacheKey}`)).orderBy(desc(fileVersions.createdAt)).limit(1);
  const parsed = environmentSurveySchema.safeParse(rows[0]?.metadata?.environmentSurvey);
  return parsed.success ? parsed.data : null;
}
export async function readProjectEnvironment(d: AppDeps, projectId: string): Promise<EnvironmentSurvey | null> {
  const site = await scope(d, projectId).catch(error => { if (error?.code === "environment_current_location_required") return null; throw error; });
  return site ? cached(d, projectId, site.cacheKey) : null;
}
async function boundedResponse(response: Response): Promise<string> {
  if (!response.ok || !response.body) throw fail("environment_source_unavailable");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 8 * 1024 * 1024) throw fail("environment_response_limit"); chunks.push(item.value); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString("utf8");
}
const timeout = (signal: AbortSignal | undefined, ms: number) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
const mappedLimitation = "Mapped roads and railways list the official topographic objects nearest to the address point. Distances run from that point to the mapped axis, not from a facade; traffic volumes, speeds and surfaces are not part of this data.";

/** Rheinland-Pfalz: Basis-DLM via the state's OGC API Features. */
async function rlpCategories(site: { latitude: number; longitude: number }, bbox: [number, number, number, number], retrievedAt: string, rawResponses: RawResponse[], signal?: AbortSignal) {
  const { latitude, longitude } = site;
  const categories: Category[] = [];
  const definitions = [
    ["roads", "Verkehr_VER01_L", "AX_Strassenachse"],
    ["rail", "Verkehr_VER03_L", "AX_Bahnstrecke"],
    ["industry", "Siedlungen_SIE02_F", "AX_IndustrieUndGewerbeflaeche"],
    ["ground_aviation", "Verkehr_VER04_F", "AX_Flugverkehr"],
  ] as const;
  const supported = longitude >= 6 && longitude <= 8.6 && latitude >= 48.9 && latitude <= 51;
  for (const [category, collection, kind] of definitions) {
    const limit = category === "roads" ? ROAD_LIMIT : LIMIT;
    const url = `${BASE}${collection}/items?f=json&bbox=${bbox.join(",")}&limit=${limit}`;
    const item: Category = { category, status: "unavailable", featureCount: 0, observations: [], coverage: { limit, returned: 0, matched: null, truncated: true }, sources: [], limitations: ["Mapped objects are observations only; activity, traffic volume and noise levels are unknown."] };
    try {
      if (!supported) throw fail("outside_connector_region");
      signal?.throwIfAborted();
      const response = await fetch(url, { signal: timeout(signal, 20000), redirect: "error" });
      const body = await boundedResponse(response); const sha256 = hash(body); const json = JSON.parse(body);
      if (json.type !== "FeatureCollection" || !Array.isArray(json.features)) throw fail("environment_invalid_response");
      rawResponses.push({ url, retrievedAt, sha256, body });
      const matched = typeof json.numberMatched === "number" ? json.numberMatched : null;
      const returned = json.features.length;
      const truncated = matched === null || matched !== returned || returned > limit || json.numberReturned !== returned;
      const selectedKinds = category === "roads" ? new Set(["AX_Strassenachse", "AX_Fahrbahnachse"]) : new Set([kind]);
      const knownKinds = category === "industry"
        ? new Set(["AX_Wohnbauflaeche", "AX_IndustrieUndGewerbeflaeche", "AX_FlaecheGemischterNutzung", "AX_FlaecheBesondererFunktionalerPraegung", "AX_SportFreizeitUndErholungsflaeche"])
        : selectedKinds;
      const validClassification = json.features.every((feature: any) => feature?.type === "Feature" && feature.properties && typeof feature.properties.objart_txt === "string" && knownKinds.has(feature.properties.objart_txt));
      const selected = json.features.filter((feature: any) => selectedKinds.has(feature?.properties?.objart_txt));
      item.featureCount = selected.length;
      item.observations = selected.slice(0, 50).map((feature: any) => ({ id: String(feature.id ?? feature.properties.gml_id ?? feature.properties.objid), kind: feature.properties.objart_txt, name: typeof feature.properties.nam === "string" ? feature.properties.nam.slice(0, 300) : null }));
      item.coverage = { limit, returned, matched, truncated };
      item.sources = [{ url, retrievedAt, sha256 }];
      item.status = !validClassification ? "unavailable" : selected.length ? "findings" : truncated ? "unavailable" : "no_features_in_query";
      if (validClassification && (category === "roads" || category === "rail")) {
        const grouped = groupMappedSources(selected.map(rlpMappedAxis).filter((axis: MappedAxis | null): axis is MappedAxis => !!axis), site);
        item.mapped = category === "roads" ? grouped.roads : grouped.rail;
        item.limitations.push(mappedLimitation);
      }
      if (!validClassification) item.limitations.push("Missing or unexpected official object classification; no absence conclusion is supported.");
      if (category === "roads" || category === "rail") item.limitations.push("Counts describe mapped axis segments, not distinct roads, rail lines or traffic movements.");
      if (category === "industry") item.limitations.push("Counts describe mapped industrial/commercial land-use areas, not identified plants, operating activity or noise emitters.");
      if (truncated) item.limitations.push("The bounded query is incomplete; missing objects cannot be excluded.");
      if (selected.length > 50) item.limitations.push("Observation summary limited to 50 objects; full retrieved data is in the private receipt.");
    } catch { signal?.throwIfAborted(); item.sources = [{ url, retrievedAt, sha256: null }]; item.limitations.push(supported ? "Official source query unavailable or response exceeded the retrieval bound." : "Location outside this connector's supported regional envelope."); }
    categories.push(item);
  }
  return categories;
}

const atkisUrl = (params: Record<string, string>) => `${HESSEN_ATKIS}?${new URLSearchParams({ SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature", ...params })}`;
async function atkisFeatures(url: string, types: string[], retrievedAt: string, rawResponses: RawResponse[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  const body = await boundedResponse(await fetch(url, { signal: timeout(signal, 30000), redirect: "error" }));
  if (!/<wfs:FeatureCollection[\s>]/.test(body)) throw fail("environment_invalid_response");
  const sha256 = hash(body);
  rawResponses.push({ url, retrievedAt, sha256, body });
  return { features: readGmlFeatures(body, types), source: { url, retrievedAt, sha256 } };
}

/** Hessen: Basis-DLM via HVBG's WFS (GML). Road names and dedication live on AX_Strasse, fetched by id. */
async function hessenCategories(site: { latitude: number; longitude: number }, bbox: [number, number, number, number], retrievedAt: string, rawResponses: RawResponse[], signal?: AbortSignal) {
  const categories: Category[] = [];
  // GML 3.2 with EPSG:4326 takes latitude first.
  const box = `${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]},urn:ogc:def:crs:EPSG::4326`;
  const definitions = [
    ["roads", ["AX_Strassenachse", "AX_Fahrbahnachse"]],
    ["rail", ["AX_Bahnstrecke"]],
    ["industry", ["AX_IndustrieUndGewerbeflaeche"]],
    ["ground_aviation", ["AX_Flugverkehr"]],
  ] as const;
  for (const [category, types] of definitions) {
    const limit = category === "roads" ? ROAD_LIMIT : LIMIT;
    const item: Category = { category, status: "unavailable", featureCount: 0, observations: [], coverage: { limit, returned: 0, matched: null, truncated: true }, sources: [], limitations: ["Mapped objects are observations only; activity, traffic volume and noise levels are unknown."] };
    try {
      const features: GmlFeature[] = [];
      let truncated = false;
      for (const type of types) {
        const url = atkisUrl({ TYPENAMES: `adv:${type}`, COUNT: String(limit + 1), SRSNAME: "urn:ogc:def:crs:EPSG::4326", BBOX: box });
        item.sources.push({ url, retrievedAt, sha256: null });
        const result = await atkisFeatures(url, [type], retrievedAt, rawResponses, signal);
        item.sources[item.sources.length - 1] = result.source;
        if (result.features.length > limit) truncated = true;
        features.push(...result.features.slice(0, limit));
      }
      const roads = new Map<string, GmlFeature>();
      if (category === "roads") {
        const ids = [...new Set(features.flatMap(feature => feature.refs.istTeilVon ?? []))].filter(id => /^[A-Za-z0-9]{16}$/.test(id));
        for (let i = 0; i < ids.length; i += 100) {
          const url = atkisUrl({ RESOURCEID: ids.slice(i, i + 100).join(",") });
          const result = await atkisFeatures(url, ["AX_Strasse"], retrievedAt, rawResponses, signal);
          item.sources.push(result.source);
          for (const road of result.features) roads.set(road.id, road);
        }
      }
      const name = (feature: GmlFeature) => (feature.fields.name?.[0] ?? (feature.refs.istTeilVon?.[0] && roads.get(feature.refs.istTeilVon[0])?.fields.name?.[0]) ?? null)?.slice(0, 300) ?? null;
      item.featureCount = features.length;
      item.observations = features.slice(0, 50).map(feature => ({ id: feature.id, kind: feature.type, name: name(feature) }));
      item.coverage = { limit, returned: features.length, matched: truncated ? null : features.length, truncated };
      item.status = features.length ? "findings" : truncated ? "unavailable" : "no_features_in_query";
      if (category === "roads" || category === "rail") {
        const grouped = groupMappedSources(features.map(feature => hessenMappedAxis(feature, roads)).filter((axis): axis is MappedAxis => !!axis), site);
        item.mapped = category === "roads" ? grouped.roads : grouped.rail;
        item.limitations.push(mappedLimitation, "Counts describe mapped axis segments, not distinct roads, rail lines or traffic movements.");
      }
      if (category === "industry") item.limitations.push("Counts describe mapped industrial/commercial land-use areas, not identified plants, operating activity or noise emitters.");
      if (truncated) item.limitations.push("The bounded query is incomplete; missing objects cannot be excluded.");
      if (features.length > 50) item.limitations.push("Observation summary limited to 50 objects; full retrieved data is in the private receipt.");
    } catch { signal?.throwIfAborted(); item.status = "unavailable"; item.limitations.push("Official source query unavailable, unrecognized or over the retrieval bound."); }
    categories.push(item);
  }
  return categories;
}

/** Fraport FRAMAP: published contour catalog and geometry extents; never a site level. */
async function checkFraport(categories: Category[], rawResponses: RawResponse[], retrievedAt: string, longitude: number, latitude: number, options: { signal?: AbortSignal }) {
  for (const category of ["flightpaths", "noise_contours"] as const) categories.push({ category, status: "not_checked", featureCount: 0, observations: [], coverage: { limit: 0, returned: 0, matched: null, truncated: false }, sources: [{ url: FLIGHTS, retrievedAt, sha256: null }], limitations: ["No flightpath or noise contour data retrieved. Nearby airport absence does not exclude overflights."] });
  const contours = categories.find(item => item.category === "noise_contours")!;
  contours.catalog = { status: "unavailable", spatialEvidence: false, layers: [] };
  // Catalog discovery is not a point-in-contour or flightpath query.
  try {
    const catalogUrls = [FLIGHTS, "https://framap.fraport.de/js/FRAMAP_THEMEN_V2.js"];
    const catalogBodies: string[] = [];
    for (const url of catalogUrls) {
      options.signal?.throwIfAborted();
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
      const body = await boundedResponse(await fetch(url, { signal, redirect: "error" }));
      const sha256 = hash(body);
      rawResponses.push({ url, retrievedAt, sha256, body });
      contours.sources.push({ url, retrievedAt, sha256 });
      catalogBodies.push(body);
    }
    const [html, themes] = catalogBodies;
    if (!/Flugl.rmkonturen \(Leq\)/.test(html!)) throw fail("environment_catalog_unrecognized");
    const layers = [...themes!.matchAll(/theme:"(ISOLINIEN(20\d{2})_(TAG|NACHT)_Z[LH])"/g)].map(match => ({ theme: match[1]!, year: Number(match[2]), period: match[3] === "TAG" ? "day" as const : "night" as const, metric: "Leq" as const }));
    if (!layers.length) throw fail("environment_catalog_unrecognized");
    const discoveredYears = [...new Set(layers.map(layer => layer.year))].sort((a, b) => b - a);
    const latestYear = discoveredYears[0]!;
    contours.selectionPolicy = { version: 1, provider: "Fraport FRAMAP", scope: "published_standard_day_night_Leq_contour_catalog", rule: "latest_year_discovered_in_retrieved_provider_catalog", selectedYear: latestYear, discoveredYears, globalLatestClaim: false, retrievedGeometryYears: [], historicalPractice: { origin: "planner_guidance", affectedYears: [2020, 2021, 2022, 2023], year: 2019, reason: "pre_COVID_historical_comparison", automaticSelection: false, engineeringApproval: false } };
    contours.catalog = { status: "retrieved", spatialEvidence: false, layers: layers.filter(layer => layer.year === latestYear) };
    contours.limitations.push(`Fraport publishes ${latestYear} day/night Leq contour layers. Catalog metadata only; site intersection, contour levels and flightpath exposure remain unchecked.`);
  } catch { options.signal?.throwIfAborted(); contours.limitations.push("Fraport catalog retrieval unavailable or unrecognized; no spatial conclusion is supported."); }
  contours.spatial = { status: "unavailable", siteLevelDbA: null, method: "published_contour_geometry_extent", layers: [] };
  if (contours.catalog.status === "retrieved") {
    try {
      const layers = contours.catalog.layers;
      const expectedThemes = new Set(["TAG_ZL", "TAG_ZH", "NACHT_ZL", "NACHT_ZH"].map(suffix => `ISOLINIEN${layers[0]?.year}_${suffix}`));
      if (layers.length !== 4 || new Set(layers.map(layer => layer.theme)).size !== 4 || layers.some(layer => !expectedThemes.has(layer.theme))) throw fail("environment_contour_catalog_incomplete");
      for (const layer of layers) {
        const url = `https://framap.fraport.de/mapviewer/dataserver/isfl?t=${encodeURIComponent(layer.theme)}&to_srid=8307`;
        const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
        const body = await boundedResponse(await fetch(url, { signal, redirect: "error" }));
        const sha256 = hash(body);
        rawResponses.push({ url, retrievedAt, sha256, body });
        contours.sources.push({ url, retrievedAt, sha256 });
        const data = JSON.parse(body);
        if (data.type !== "FeatureCollection" || data.collectionName !== layer.theme || data.srs !== 8307 || data.geodetic !== true || !Array.isArray(data.features) || !data.features.length || data.features.length > 1000 || data.seq !== undefined || data.hasMore || data.next) throw fail("environment_contour_geometry_unverified");
        const extent: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
        const levels = new Set<number>(); let attributesComplete = true;
        for (const feature of data.features) {
          const coordinates = feature.geometry?.coordinates;
          if (feature.type !== "Feature" || feature.geometry?.type !== "LineString" || !Array.isArray(coordinates) || coordinates.length < 4 || coordinates.length % 2) throw fail("environment_contour_geometry_unverified");
          for (let i = 0; i < coordinates.length; i += 2) {
            const x = coordinates[i], y = coordinates[i + 1];
            if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90) throw fail("environment_contour_coordinates_unverified");
            extent[0] = Math.min(extent[0], x); extent[1] = Math.min(extent[1], y); extent[2] = Math.max(extent[2], x); extent[3] = Math.max(extent[3], y);
          }
          const level = Number(feature.properties?.Pegelwert);
          if (feature.properties?.Pegelart === (layer.period === "day" ? "LAEQTAG" : "LAEQNACHT") && Number.isFinite(level) && level > 0 && level < 150) levels.add(level);
          else attributesComplete = false;
        }
        if (!Array.isArray(data.bbox) || data.bbox.length !== 4 || data.bbox.some((value: unknown, index: number) => typeof value !== "number" || Math.abs(value - extent[index]!) > 0.00002)) throw fail("environment_contour_extent_mismatch");
        contours.spatial.layers.push({ ...layer, srid: 8307, extent, geometryCount: data.features.length, publishedLevelsDbA: [...levels].sort((a, b) => a - b), levelAttributesComplete: attributesComplete, relation: longitude < extent[0] || longitude > extent[2] || latitude < extent[1] || latitude > extent[3] ? "outside_published_contour_extent" : "within_extent_unresolved" });
      }
      contours.spatial.status = "checked";
      if (contours.selectionPolicy) contours.selectionPolicy.retrievedGeometryYears = [contours.selectionPolicy.selectedYear];
      contours.status = "findings";
      contours.featureCount = contours.spatial.layers.reduce((sum, layer) => sum + layer.geometryCount, 0);
      contours.coverage = { limit: 4000, returned: contours.featureCount, matched: contours.featureCount, truncated: false };
      contours.limitations = ["Checked relation to the full retrieved latest-year Fraport contour geometry extents in WGS84 (Oracle SRID 8307). Duplicate geometries across label/detail layers are counted separately.", "Outside the published contour extent does not establish site noise level, absence of aircraft noise or absence of overflights. Within an extent remains unresolved; no interpolation or threshold classification is performed.", "Published contour values are source attributes, not site measurements or engineering approval. Some detail features omit level attributes; these are not inferred."];
    } catch { options.signal?.throwIfAborted(); contours.status = "unavailable"; contours.limitations.push("Spatial contour retrieval or coordinate verification incomplete; no site noise conclusion is supported."); }
  }}

export async function researchProjectEnvironment(d: AppDeps, projectId: string, options: { refresh?: boolean; revision?: number; signal?: AbortSignal } = {}): Promise<EnvironmentSurvey> {
  d.requirePermission("projects:write");
  const scoped = await scope(d, projectId);
  if (options.revision !== undefined && options.revision !== scoped.revision) throw fail("revision_conflict");
  if (!options.refresh) { const prior = await cached(d, projectId, scoped.cacheKey); if (prior) return prior; }
  const retrievedAt = new Date().toISOString();
  const rawResponses: RawResponse[] = [];
  let site: { siteId: string; address: string; latitude: number; longitude: number };
  if (scoped.kind === "location") site = scoped.site;
  else {
    const resolved = await resolveHessenAddress(scoped.address, timeout(options.signal, 20000)).catch(error => { options.signal?.throwIfAborted(); throw error; });
    if (!resolved) throw fail("environment_current_location_required", "Site address not found in Hessen's house coordinates. Import the site location (Berlin, Rheinland-Pfalz) or check the address in project details.");
    rawResponses.push({ url: resolved.sourceUrl, retrievedAt, sha256: hash(resolved.body), body: resolved.body });
    site = resolved;
  }
  const { latitude, longitude } = site;
  // This is a bounded planning search rectangle, not an acoustic propagation model.
  const dy = 1000 / 111320, dx = 1000 / (111320 * Math.cos(latitude * Math.PI / 180));
  const bbox: [number, number, number, number] = [longitude - dx, latitude - dy, longitude + dx, latitude + dy];
  const categories = scoped.kind === "location"
    ? await rlpCategories(site, bbox, retrievedAt, rawResponses, options.signal)
    : await hessenCategories(site, bbox, retrievedAt, rawResponses, options.signal);
  await checkFraport(categories, rawResponses, retrievedAt, longitude, latitude, options);
  const connector = scoped.kind === "location" ? CONNECTOR : HESSEN_CONNECTOR;
  const fileId = randomUUID(), versionId = randomUUID();
  const receipt = environmentSurveySchema.parse({ id: randomUUID(), fileId, versionId, projectId, connectorVersion: connector, cacheKey: scoped.cacheKey, retrievedAt, downloadUrl: `/api/projects/${projectId}/files/${fileId}/versions/1/download`, site: { siteId: site.siteId, address: site.address, latitude, longitude, revision: scoped.revision }, scope: { radiusMeters: 1000, bbox, purpose: "planning_context" }, categories, engineeringApproval: false, noiseMetrics: "unknown", limitations: ["ATKIS Basis-DLM is topographic context, not an exhaustive inventory of noise sources or an acoustic assessment.", "Search radius is a planning default; relevant sources may lie outside the query.",
    ...(scoped.kind === "location" ? ["©GeoBasis-DE / LVermGeoRP, dl-de/by-2-0; data retrieved as recorded per source."] : ["Site point: official house coordinate (Hauskoordinaten Hessen), not a surveyed setting-out point.", `${hessenAttribution} Data retrieved as recorded per source.`])] });
  const payload = JSON.stringify({ format: "richtfest-environment-receipt-v1", receipt, rawResponses });
  const storageKey = `${d.tenantId}/${projectId}/${fileId}/${versionId}`;
  const saved = await d.fileStorage.saveStream(storageKey, Readable.from([payload]), "application/json");
  try {
    return await d.db.transaction(async (tx: any) => {
      // Serialize receipt creation against the project and recheck the current pin after network I/O.
      await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.tenantId, d.tenantId))).for("update");
      await tx.select({ id: projectLocations.projectId }).from(projectLocations).where(and(eq(projectLocations.projectId, projectId), eq(projectLocations.tenantId, d.tenantId))).for("update");
      const current = await scope(d, projectId, tx);
      if (current.cacheKey !== scoped.cacheKey || current.revision !== scoped.revision) throw fail("environment_location_changed");
      if (!options.refresh) { const prior = await cached(d, projectId, scoped.cacheKey, tx); if (prior) { await d.fileStorage.remove(storageKey); return prior; } }
      await tx.insert(files).values({ id: fileId, tenantId: d.tenantId, projectId, name: `Environment survey ${retrievedAt.slice(0, 10)}.json`, sourceType: "environment_research", purpose: "project_evidence", sourceRef: scoped.kind === "location" ? BASE : HESSEN_ATKIS, createdBy: d.actorId });
      await tx.insert(fileVersions).values({ id: versionId, tenantId: d.tenantId, fileId, version: 1, status: "ready", sourceMetadata: { environmentCacheKey: scoped.cacheKey, environmentSurvey: receipt }, checksum: saved.checksum, storageKey, sizeBytes: saved.sizeBytes, mimeType: "application/json", createdBy: d.actorId });
      await d.audit(tx, "projects.environment.researched", "file", fileId, { projectId, versionId, cacheKey: scoped.cacheKey, connectorVersion: connector });
      return receipt;
    });
  } catch (error) { await d.fileStorage.remove(storageKey).catch(() => {}); throw error; }
}
