import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import express from "express";
import { projectAddressInput } from "@richtfest/shared";
import { createInquiriesRouter } from "@richtfest/projects/inquiries";
import { createNoiseSourcesRouter } from "@richtfest/projects/noise-sources";
import { createDatabase } from "./db/client";

const url = process.env.BUILDING_EXTRACTION_TEST_DATABASE_URL;
const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);

(local ? test : test.skip)("noise sources keep versioned inputs and drive the progress of their traffic data inquiry", async () => {
  const namespace = `noise_sources_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(url!); await admin.pool.query(`CREATE SCHEMA ${namespace}`);
  const isolated = new URL(url!); isolated.searchParams.set("options", `-c search_path=${namespace}`);
  const { db, pool } = createDatabase(isolated.href);
  const tenant = crypto.randomUUID(), project = crypto.randomUUID(), actor = crypto.randomUUID();
  const audits: string[] = [];
  const deps = () => ({ db, tenantId: tenant, actorId: actor, requirePermission() {}, audit: async (_tx: unknown, action: string) => { audits.push(action); },
    validateCustomer: async () => false, customerNames: async () => ({}), fileStorage: {} as any, inboundEmailDomain: null }) as any;
  const app = express();
  app.use(express.json()); app.use(createInquiriesRouter(deps)); app.use(createNoiseSourcesRouter(deps));
  app.use((e: any, _req: any, res: any, _next: any) => res.status(e.status ?? (e.name === "ZodError" ? 400 : 500)).json({ message: e.message }));
  const server = app.listen(0); const root = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const r = await fetch(root + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  const base = `/projects/${project}/noise-sources`;
  try {
    for (const table of ["projects_projects", "projects_locations", "projects_files", "projects_file_versions", "projects_inquiries", "projects_inquiry_entries",
      "projects_inbound_mailboxes", "projects_noise_sources", "projects_noise_source_values"])
      await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    await pool.query("insert into projects_projects (id,tenant_id,name,street,postal_code,city,created_by) values ($1,$2,'Noise test','Friedrich-Ebert-Anlage 11a','63450','Hanau',$3)", [project, tenant, actor]);
    // A saved Hessen environment survey with one mapped road, stored the way the connector caches it.
    const [address] = (await pool.query("select street, postal_code as \"postalCode\", city, country from projects_projects where id=$1", [project])).rows;
    const cacheKey = createHash("sha256").update(JSON.stringify({ connector: "he-basis-dlm-hako-framap-v1", address: projectAddressInput.parse(address) })).digest("hex");
    const fileId = crypto.randomUUID(), road = { kind: "road", ref: "road:gallienstraße|1307|", name: "Gallienstraße", dedication: "1307", designation: null, lanes: 2, carriagewayWidthM: null, distanceMeters: 21, segments: 10 };
    const category = (name: string, mapped: unknown[]) => ({ category: name, status: "findings", featureCount: 1, observations: [], coverage: { limit: 2000, returned: 1, matched: 1, truncated: false }, sources: [], mapped, limitations: [] });
    const survey = { id: crypto.randomUUID(), fileId, versionId: crypto.randomUUID(), projectId: project, connectorVersion: "he-basis-dlm-hako-framap-v1", cacheKey, retrievedAt: new Date().toISOString(),
      downloadUrl: "/api/x", site: { siteId: "he-hako:X", address: "Friedrich-Ebert-Anlage 11a, Hanau", latitude: 50.13, longitude: 8.92, revision: 0 }, scope: { radiusMeters: 1000, bbox: [0, 0, 1, 1], purpose: "planning_context" },
      categories: [category("roads", [road]), category("rail", [])], engineeringApproval: false, noiseMetrics: "unknown", limitations: [] };
    await pool.query("insert into projects_files (id,tenant_id,project_id,name,source_type,purpose,created_by) values ($1,$2,$3,'survey.json','environment_research','project_evidence',$4)", [fileId, tenant, project, actor]);
    await pool.query("insert into projects_file_versions (id,tenant_id,file_id,version,status,source_metadata,storage_key,created_by) values ($1,$2,$3,1,'ready',$4,'k',$5)",
      [survey.versionId, tenant, fileId, JSON.stringify({ environmentCacheKey: cacheKey, environmentSurvey: survey }), actor]);

    const listed = await call(base);
    expect(listed.status).toBe(200);
    expect(listed.body.data.survey.roads).toHaveLength(1);
    // A mapped road is added once, with a snapshot of what was mapped; refs outside the current survey are refused.
    const mapped = await call(base, { mappedRef: road.ref });
    expect(mapped.status).toBe(201);
    expect(mapped.body.data).toMatchObject({ kind: "road", name: "Gallienstraße", mapped: { distanceMeters: 21, surveyFileId: fileId } });
    expect((await call(base, { mappedRef: road.ref })).body.error.code).toBe("already_added");
    expect((await call(base, { mappedRef: "road:elsewhere" })).status).toBe(409);
    const rail = (await call(base, { kind: "rail", name: "Strecke 3680" })).body.data;
    const roadId = mapped.body.data.id;

    // Inputs are validated per kind and versioned; a stale edit is a conflict, not an overwrite.
    const put = (id: string, key: string, body: unknown) => call(`${base}/${id}/inputs/${key}`, body, "PUT");
    expect((await put(roadId, "dailyTraffic", { value: 12400, basis: "Verkehrsmengenkarte 2021", expectedVersion: 0 })).status).toBe(200);
    expect((await put(roadId, "dailyTraffic", { value: 13000, expectedVersion: 0 })).status).toBe(409);
    expect((await put(roadId, "dailyTraffic", { value: -5, expectedVersion: 1 })).status).toBe(422);
    expect((await put(roadId, "trainVolumes", { value: "20 Züge", expectedVersion: 0 })).status).toBe(422);
    expect((await put(roadId, "heavyVehicleShare", { value: 101, expectedVersion: 0 })).status).toBe(422);
    let sources = (await call(base)).body.data.sources;
    const current = sources.find((source: any) => source.id === roadId);
    expect(current.inputs.dailyTraffic).toMatchObject({ value: 12400, unit: "Kfz/24h", basis: "Verkehrsmengenkarte 2021", version: 1 });
    expect(current.missing).toEqual(["heavyVehicleShare", "speedLimit", "roadSurface", "distanceToFacade", "trafficBasis"]);

    // The request asks only for what an authority supplies and is still missing: not the entered DTV, not the facade distance.
    const created = await call(`${base}/request`, { sourceIds: [roadId, rail.id], title: "Verkehrsdaten", counterpart: "Stadt Hanau", request: { body: "Bitte um Verkehrsdaten" } });
    expect(created.status).toBe(201);
    expect(created.body.data.items).toEqual([
      { sourceId: roadId, kind: "road", name: "Gallienstraße", fields: ["heavyVehicleShare", "speedLimit", "roadSurface", "trafficBasis"] },
      { sourceId: rail.id, kind: "rail", name: "Strecke 3680", fields: ["trainVolumes", "speed", "trackType", "trafficBasis"] },
    ]);
    const inquiryId = created.body.data.id;
    sources = (await call(base)).body.data.sources;
    expect(sources.every((source: any) => source.inquiryId === inquiryId)).toBe(true);
    const progress = async () => (await call(`/projects/${project}/inquiries/${inquiryId}`)).body.data.progress;
    expect(await progress()).toMatchObject({ total: 8, answered: 0 });

    await put(roadId, "speedLimit", { value: 50, expectedVersion: 0 });
    expect((await progress()).answered).toBe(1);
    // Clearing a value reopens it.
    await put(roadId, "speedLimit", { value: null, expectedVersion: 1 });
    expect((await progress()).answered).toBe(0);
    // A removed source drops out of the request.
    expect((await call(`${base}/${rail.id}`, undefined, "DELETE")).status).toBe(200);
    const list = (await call(`/projects/${project}/inquiries`)).body.data;
    expect(list[0].progress).toMatchObject({ total: 4, answered: 0 });
    expect(list[0].progress.outstanding).toEqual([{ sourceId: roadId, kind: "road", name: "Gallienstraße", fields: ["heavyVehicleShare", "speedLimit", "roadSurface", "trafficBasis"] }]);
    expect((await call(`${base}/request`, { sourceIds: [crypto.randomUUID()], title: "x", counterpart: "y", request: { body: "z" } })).status).toBe(422);
    expect(audits).toEqual(expect.arrayContaining(["projects.noise_source.created", "projects.noise_source.input_set", "projects.inquiry.created", "projects.noise_source.removed"]));
  } finally {
    server.close(); await pool.end(); await admin.pool.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.pool.end();
  }
});
