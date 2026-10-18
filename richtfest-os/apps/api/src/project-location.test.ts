import { expect, test } from "bun:test";
import express from "express";
import { sql } from "drizzle-orm";
import { createRouter } from "@richtfest/projects";
import { runLocationJob } from "@richtfest/projects/location-worker";
import { locationImageVersion, type LocationContext } from "@richtfest/shared";
import { fileStorage } from "./file-storage";
import { createDatabase } from "./db/client";

const url = process.env.DATABASE_URL;
// Never run this mutation-based integration test against a remote database.
const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
(local ? test : test.skip)("location API persists scenes, scopes tenants/permissions, fences revisions and recovers durable jobs", async () => {
  const schema = `location_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(url!);
  await admin.pool.query(`CREATE SCHEMA ${schema}`);
  const isolatedUrl = new URL(url!); isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
  const { db, pool } = createDatabase(isolatedUrl.href);
  const tenant = crypto.randomUUID(), other = crypto.randomUUID(), project = crypto.randomUUID(), actor = crypto.randomUUID();
  let auditCount = 0;
  const app = express(); app.use(express.json());
  app.use("/api", createRouter(req => ({ db, tenantId: req.headers["x-test-tenant"] === "other" ? other : tenant, actorId: actor,
    requirePermission(permission) { if (req.headers["x-test-access"] === "none" || (permission === "projects:write" && req.headers["x-test-access"] === "read")) throw Object.assign(new Error("Forbidden"), { status:403 }); },
    audit: async (tx, action, _type, id) => { await tx.execute(sql`insert into test_audit (action, project_id) values (${action}, ${id})`); auditCount++; },
    validateCustomer: async () => false, customerNames: async () => ({}), fileStorage: {} as any,
  })));
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? (error.name === "ZodError" ? 400 : 500)).json({ data:null, error:{code:error.code}, message:error.message }));
  const server = app.listen(0), base = `http://127.0.0.1:${(server.address() as any).port}/api/projects/${project}/location`;
  const request = async (suffix = "", method = "GET", body?: unknown, headers: Record<string,string> = {}) => {
    const r = await fetch(base+suffix, { method, headers: { "content-type":"application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status:r.status, body:await r.json() };
  };
  try {
    await pool.query(`CREATE TABLE projects_projects (id uuid primary key, tenant_id uuid, name text, created_by uuid, status text, customer_id uuid, created_at timestamptz);
      CREATE TABLE test_audit (action text, project_id uuid)`);
    await pool.query(await Bun.file(new URL("../drizzle/0023_project_locations.sql", import.meta.url)).text());
    await pool.query(await Bun.file(new URL("../drizzle/0024_project_address.sql", import.meta.url)).text());
    await pool.query(await Bun.file(new URL("../drizzle/0025_project_address_reference.sql", import.meta.url)).text());
    await pool.query("insert into projects_projects (id,tenant_id,name,created_by) values ($1,$2,'Location test',$3)", [project,tenant,actor]);
    expect((await request()).body.data).toMatchObject({ revision:0, scene:{objects:[],planningNotes:""}, context:null, contextJob:{status:"idle"}, lidarJob:{status:"idle"} });
    for (const [suffix,method,body] of [["","GET",undefined],["","PUT",{revision:0,scene:{objects:[],planningNotes:"x"}}],["/import","POST",{revision:0}],["/lidar","POST",{}],["/lidar","GET",undefined]] as const) {
      expect((await request(suffix,method,body,{"x-test-tenant":"other"})).status).toBe(404);
      expect((await request(suffix,method,body,{"x-test-access":"none"})).status).toBe(403);
    }
    expect((await request("","PUT",{revision:0,scene:{objects:[],planningNotes:"x"}},{"x-test-access":"read"})).status).toBe(403);
    expect((await request("/lidar","POST",{})).status).toBe(409);
    const input = { revision:0,scene:{objects:[],planningNotes:"Durable notes"} };
    const results = await Promise.all([request("","PUT",input),request("","PUT",input)]);
    expect(results.map(r=>r.status).sort()).toEqual([200,409]);
    expect((await request()).body.data).toMatchObject({ revision:1,scene:input.scene });
    expect((await request("/import","POST",{siteId:"wrong"})).status).toBe(400);
    expect((await request("/import","POST",{revision:1})).status).toBe(422);
    const address = { street:"Giersstraße 20", postalCode:"13088", city:"Berlin", country:"DE" };
    const patchProject = async (body: unknown, headers: Record<string,string> = {}) => {
      const response = await fetch(base.replace(/\/location$/, ""), { method:"PATCH", headers:{"content-type":"application/json",...headers}, body:JSON.stringify(body) });
      return { status:response.status, body:await response.json() };
    };
    expect((await patchProject(address,{"x-test-tenant":"other"})).status).toBe(404);
    expect((await patchProject(address,{"x-test-access":"read"})).status).toBe(403);
    expect((await patchProject({ ...address, street:"  Giersstraße 20  " })).body.data).toMatchObject(address);
    expect((await patchProject({ name:"Renamed" })).body.data).toMatchObject(address);
    const addressReference = { provider:"geoapify", placeId:"address-20", longitude:13.4826, latitude:52.5575, attribution:"Powered by Geoapify · © OpenStreetMap contributors" };
    expect((await patchProject({ ...address, addressReference })).body.data.addressReference).toEqual(addressReference);
    expect((await patchProject({ name:"Selected address retained" })).body.data.addressReference).toEqual(addressReference);
    expect((await patchProject({ addressReference })).status).toBe(400);
    expect((await patchProject({ ...address, addressReference:{...addressReference, latitude:91} })).status).toBe(400);
    expect((await patchProject({ postalCode:"13088" })).body.data.addressReference).toBeNull();
    const suggestionsUrl = base.replace(`/${project}/location`, "/address-suggestions");
    expect(await (await fetch(suggestionsUrl)).json()).toMatchObject({ data:{configured:false,suggestions:[]} });
    expect((await fetch(suggestionsUrl+"?q=ab")).status).toBe(400);
    expect((await fetch(suggestionsUrl,{headers:{"x-test-access":"read"}})).status).toBe(403);
    expect((await request("/import","POST",{revision:0})).status).toBe(409);
    const before = auditCount, queued = await request("/import","POST",{revision:1});
    expect(queued.status).toBe(202); expect(queued.body.data.contextJob.status).toBe("queued"); expect(queued.body.data.revision).toBe(2);
    expect((await request("/import","POST",{revision:2})).body.data.contextJob.status).toBe("queued"); expect(auditCount).toBe(before+1);
    expect((await request("","PUT",{revision:2,scene:input.scene})).status).toBe(409);
    await patchProject({street:"Giersstraße 21"});
    expect((await pool.query("select requested_address from projects_locations")).rows[0].requested_address).toEqual(address);
    await patchProject(address);
    // Simulated abrupt stop: database retains an expired running job. An aborted
    // upstream request avoids network dependency while exercising claim/recovery.
    await pool.query("update projects_locations set context_status='running', lease_token=$1, lease_until=now()-interval '1 minute'",[crypto.randomUUID()]);
    const controller = new AbortController(); controller.abort();
    const worker = { db, audit: async (tx: any, _tenant: string, action: string, id: string) => { await tx.execute(sql`insert into test_audit (action,project_id) values (${action},${id})`); }, reportError: () => {} };
    expect(await runLocationJob(worker,controller.signal)).toBe(true);
    const recovered = (await request()).body.data; expect(recovered.contextJob.status).toBe("queued"); expect(recovered.contextJob.error).toBeNull(); expect(recovered.scene).toEqual(input.scene);
    // An inconsistent source record fails honestly without inventing a cloud.
    await pool.query("update projects_locations set context_status='ready',lidar_status='queued'");
    expect(await runLocationJob(worker,new AbortController().signal)).toBe(true);
    expect((await request()).body.data.lidarJob).toMatchObject({status:"failed",error:"Location context missing; import first"});
    await pool.query("update projects_locations set context_status='failed'");
    expect((await request("/import","POST",{revision:2})).body.data.contextJob.status).toBe("queued");
    await pool.query("update projects_locations set context_status='running',lease_until=now()+interval '1 minute'");
    expect(await runLocationJob(worker,controller.signal)).toBe(false);
    const context = { siteId:"berlin-giersstrasse-20", address:"Giersstraße 20, 13088 Berlin", origin:[397139.418,5824134.851], radius:100 }, cloud = { positions:[0,0,0], classifications:[2], groundElevation:40, sourcePointCount:1, sampled:false, surveyedAt:"2021", sourceUrl:"https://gdi.berlin.de" };
    await pool.query("update projects_locations set context=$1,context_status='ready',lease_until=null",[JSON.stringify(context)]);
    expect((await request("/lidar","POST",{})).body.data.lidarJob.status).toBe("queued");
    expect((await request("/lidar")).status).toBe(409);
    await pool.query("update projects_locations set cloud=$1,lidar_status='ready'",[JSON.stringify(cloud)]);
    expect((await request("/lidar")).body.data).toEqual(cloud);
    expect((await request()).body.data.cloud).toBeUndefined();
    expect(Number((await pool.query("select count(*) from test_audit")).rows[0].count)).toBeGreaterThan(3);
    await pool.query(`CREATE TABLE projects_files (id uuid primary key, tenant_id uuid, project_id uuid);
      CREATE TABLE projects_file_versions (file_id uuid, tenant_id uuid, version integer, status text)`);
    const sourceId = crypto.randomUUID();
    await pool.query("insert into projects_files values ($1,$2,$3)", [sourceId, tenant, project]);
    await pool.query("insert into projects_file_versions values ($1,$2,1,'ready')", [sourceId, tenant]);
    const scene = { objects: [{ id: "ifc", kind: "ifc", label: "Source", note: "", position: [-7.5,0,9.25], size: [3,4,2], rotation: 30, source: { fileId: sourceId, version: 1 } }], planningNotes: "Source-linked IFC" };
    expect((await request("", "PUT", { revision: 3, scene })).status).toBe(200);
    expect((await request()).body.data.scene).toEqual(scene);
    // Matching legacy sites stay exactly where imported, including IFC alignment.
    expect((await request("/import","POST",{revision:4})).body.data.context).toEqual(context);
    await patchProject({ street:"Giersstraße 21" });
    expect((await request("/import","POST",{revision:4})).body.error.code).toBe("location_has_objects");
    expect((await request()).body.data).toMatchObject({context,scene,revision:4});
    for (const [query, args] of [
      ["update projects_files set tenant_id=$1", [other]],
      ["update projects_files set tenant_id=$1, project_id=$2", [tenant, crypto.randomUUID()]],
      ["update projects_files set project_id=$1; update projects_file_versions set status='pending'", [project]],
    ] as [string, string[]][]) {
      // Separate statements because PostgreSQL prepared queries accept one command.
      for (const statement of query.split(";")) await pool.query(statement, statement.includes("$1") ? args : []);
      expect((await request("", "PUT", { revision: 4, scene })).status).toBe(404);
      expect((await request()).body.data.revision).toBe(4);
    }
    expect((await request("", "PUT", { revision:4, scene:input.scene })).status).toBe(200);
    const replaced = await request("/import", "POST", {revision:5});
    expect(replaced.body.data).toMatchObject({revision:6, context:null, scene:input.scene, contextJob:{status:"queued"}, lidarJob:{status:"idle"}});
    expect((await request("/lidar")).status).toBe(409);
    expect((await request("", "PUT", {revision:4,scene:input.scene})).status).toBe(409);
    // General measurements round-trip in the scene without creating domain records.
    const reference = { siteId: context.siteId, origin: context.origin, crs: "EPSG:25833", importedAt: "2026-10-18T08:00:00Z" };
    await pool.query("update projects_locations set context=$1,context_status='ready'", [JSON.stringify({ ...context, ...reference })]);
    const measurement = { id: crypto.randomUUID(), description: "Neighbor, not the road", purpose: "neighbor", points: [[-4, 3, 7], [8, 8, -2]], context: reference };
    const measuredScene = { ...input.scene, measurements: [measurement] };
    expect((await request("", "PUT", { revision:6, scene:measuredScene }, {"x-test-access":"read"})).status).toBe(403);
    expect((await request("", "PUT", { revision:6, scene:measuredScene }, {"x-test-tenant":"other"})).status).toBe(404);
    expect((await request("", "PUT", { revision:6, scene:measuredScene })).status).toBe(200);
    expect((await request()).body.data.scene).toEqual(measuredScene);
    expect((await request("/import", "POST", {revision:7})).body.error.code).toBe("location_has_objects");
    // An older client can save notes without silently erasing measurements.
    expect((await request("", "PUT", {revision:7,scene:input.scene})).body.data.scene.measurements).toEqual([measurement]);
    for (const measurements of [
      [measurement, measurement],
      [{ ...measurement, purpose:"inferred_noise" }],
      [{ ...measurement, points:[[0,0], [1,2,3]] }],
    ]) expect((await request("", "PUT", {revision:8,scene:{...input.scene,measurements}})).status).toBe(400);
    const wrongFrame = { ...measurement, id:crypto.randomUUID(), context:{...reference, origin:[1,2]} };
    expect((await request("", "PUT", {revision:8,scene:{...input.scene,measurements:[wrongFrame]}})).body.error.code).toBe("measurement_context_changed");
    const concurrent = await Promise.all([
      request("", "PUT", {revision:8,scene:measuredScene}),
      request("", "PUT", {revision:8,scene:{...measuredScene,planningNotes:"Concurrent writer"}}),
    ]);
    expect(concurrent.map(result => result.status).sort()).toEqual([200,409]);
    // A refresh preserves the historical measurement reference, not a claim to newer source data.
    await pool.query("update projects_locations set context=$1", [JSON.stringify({ ...context, ...reference, importedAt:"2026-10-19T08:00:00Z" })]);
    expect((await request("", "PUT", {revision:9,scene:measuredScene})).body.data.scene.measurements[0]).toEqual(measurement);
    const outdated = { ...measurement, id:crypto.randomUUID() };
    expect((await request("", "PUT", {revision:10,scene:{...input.scene,measurements:[outdated]}})).body.error.code).toBe("measurement_context_changed");
    expect((await request("", "PUT", {revision:10,scene:{...input.scene,measurements:[]}})).body.data.scene.measurements).toEqual([]);
    expect((await request()).body.data.scene.measurements).toEqual([]);
    expect((await request("/import", "POST", {revision:11})).body.data.contextJob.status).toBe("queued");
  } finally { server.close(); await pool.end(); await admin.pool.query(`DROP SCHEMA ${schema} CASCADE`); await admin.pool.end(); }
}, 30000);

(local ? test : test.skip)("location images persist across API instances, deduplicate downloads and retain safe fallback during rate limits", async () => {
  // Use actual local object storage, never a configured production bucket.
  expect(fileStorage.kind).toBe("local");
  const schema = `imagery_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(url!);
  await admin.pool.query(`CREATE SCHEMA ${schema}`);
  const isolated = new URL(url!); isolated.searchParams.set("options", `-c search_path=${schema}`);
  let primary = createDatabase(isolated.href);
  const replica = createDatabase(isolated.href);
  const tenant = crypto.randomUUID(), other = crypto.randomUUID(), project = crypto.randomUUID(), otherProject = crypto.randomUUID();
  const context: LocationContext = { siteId: "berlin-image-test", address: "Berlin", origin: [397139.4, 5824134.9], radius: 100,
    longitude: 13, latitude: 52, buildings: [], trees: [], sources: [], importedAt: "2026-10-18T00:00:00.000Z" };
  const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==", "base64");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const originalFetch = globalThis.fetch;
  let downloads = 0;
  let upstream: (url: URL) => Promise<Response> = async url => new Response(url.searchParams.get("FORMAT") === "image/png" ? png : jpeg,
    { headers: { "content-type": url.searchParams.get("FORMAT")! } });
  globalThis.fetch = (async (input: any, init: any) => {
    const target = new URL(String(input));
    if (["gdi.berlin.de", "geo4.service24.rlp.de", "geoinformation.eisenbahn-bundesamt.de"].includes(target.hostname)) {
      downloads++;
      return upstream(target);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  const start = (index: number) => {
    const app = express();
    app.use("/api", createRouter(req => ({ db: (index ? replica : primary).db,
      tenantId: req.headers["x-test-tenant"] === "other" ? other : tenant, actorId: tenant, fileStorage,
      requirePermission() { if (req.headers["x-test-access"] === "none") throw Object.assign(new Error("Forbidden"), { status: 403 }); },
      audit: async (tx, action) => { await tx.execute(sql`insert into test_audit (action) values (${action})`); },
      validateCustomer: async () => false, customerNames: async () => ({}),
    })));
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ error: error.code }));
    return app.listen(0);
  };
  const servers = [start(0), start(1)];
  const image = async (suffix = "aerial/near", instance = 0, headers = {}, id = project, version = locationImageVersion(context)) => {
    const res = await originalFetch(`http://127.0.0.1:${(servers[instance].address() as any).port}/api/projects/${id}/location/${suffix}?v=${encodeURIComponent(version)}`, { headers });
    return { res, bytes: Buffer.from(await res.arrayBuffer()) };
  };
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error("Upstream request did not start"); await Bun.sleep(10); }
  };
  try {
    await primary.pool.query(`CREATE TABLE projects_projects (id uuid primary key, tenant_id uuid, name text, street text, postal_code text, city text, country text, address_reference jsonb,
      customer_id uuid, status text, created_by uuid, created_at timestamptz);
      CREATE TABLE test_audit (action text)`);
    for (const migration of ["0023_project_locations", "0049_location_images"])
      await primary.pool.query(await Bun.file(new URL(`../drizzle/${migration}.sql`, import.meta.url)).text());
    for (const [id, owner] of [[project, tenant], [otherProject, other]]) {
      await primary.pool.query("insert into projects_projects (id, tenant_id, name) values ($1,$2,'Imagery test')", [id, owner]);
      await primary.pool.query("insert into projects_locations (project_id, tenant_id, context) values ($1,$2,$3)", [id, owner, JSON.stringify(context)]);
    }
    // Separate API instances race on an empty cache; only one goes to the provider.
    const success = upstream;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    upstream = async url => { await gate; return success(url); };
    const batch = Promise.all(Array.from({ length: 6 }, (_, i) => image("aerial/near", i % 2)));
    await waitFor(() => downloads === 1); await Bun.sleep(300); release();
    for (const result of await batch) { expect(result.res.status).toBe(200); expect(result.bytes).toEqual(jpeg); }
    expect(downloads).toBe(1);
    expect((await image()).res.headers.get("cache-control")).toMatch(/^private, max-age=604\d+/);
    const [cached] = (await primary.pool.query("select * from projects_location_images where tenant_id=$1", [tenant])).rows;
    expect(cached.source_url).toContain("truedop_2024"); expect(cached.attribution).toContain("Geoportal Berlin");
    expect(cached.size_bytes).toBe(jpeg.length);

    // Recreate both the HTTP app and its DB connection: only durable bytes can satisfy this.
    servers[0].close(); await primary.pool.end(); primary = createDatabase(isolated.href); servers[0] = start(0);
    upstream = async () => new Response("Rate limited", { status: 429, headers: { "retry-after": "180" } });
    expect((await image()).bytes).toEqual(jpeg); expect(downloads).toBe(1);
    expect((await image("aerial/near", 0, { "x-test-tenant": "other" })).res.status).toBe(404);
    expect((await image("aerial/near", 0, { "x-test-access": "none" })).res.status).toBe(403);
    expect(downloads).toBe(1);

    // A failed refresh preserves the last good image and a shared Retry-After cooldown.
    await primary.pool.query("update projects_location_images set fresh_until=now()-interval '1 second'");
    const fallback = await image(); expect(fallback.bytes).toEqual(jpeg);
    expect(fallback.res.headers.get("x-imagery-cache")).toBe("stale");
    expect(fallback.res.headers.get("cache-control")).toBe("private, no-cache");
    const [failed] = (await primary.pool.query("select * from projects_location_images")).rows;
    expect(failed.fetched_at).toEqual(cached.fetched_at);
    expect(failed.retry_at.getTime()).toBeGreaterThan(Date.now() + 170_000);
    expect((await image("aerial/near", 1)).bytes).toEqual(jpeg); expect(downloads).toBe(2);

    // A different extent has no stale fallback, and also backs off across replicas.
    const far = await image("aerial/far"); expect(far.res.status).toBe(503);
    expect(Number(far.res.headers.get("retry-after"))).toBeGreaterThan(170);
    expect((await image("aerial/far", 1)).res.status).toBe(503); expect(downloads).toBe(3);
    upstream = success;
    // Equal public imagery never bypasses another tenant's cache/access boundary.
    expect((await image("aerial/near", 1, { "x-test-tenant": "other" }, otherProject)).bytes).toEqual(jpeg); expect(downloads).toBe(4);
    expect((await image("rail-noise")).bytes).toEqual(png); expect(downloads).toBe(5);
    expect((await image("rail-noise", 1)).bytes).toEqual(png); expect(downloads).toBe(5);

    // Missing object + abandoned lease recovers from storage, not from an in-process cache.
    await fileStorage.remove(cached.storage_key);
    await primary.pool.query("update projects_location_images set retry_at=null, lease_token=$2, lease_until=now()-interval '1 second' where id=$1", [cached.id, crypto.randomUUID()]);
    expect((await image()).bytes).toEqual(jpeg); expect(downloads).toBe(6);

    // A moved site's old URL is rejected; even a provider outage cannot borrow the old site.
    const moved = { ...context, origin: [397839.4, 5824134.9] as [number, number] };
    await primary.pool.query("update projects_locations set context=$1 where project_id=$2", [JSON.stringify(moved), project]);
    expect((await image()).res.status).toBe(409); expect(downloads).toBe(6);
    upstream = async () => new Response("<ServiceException/>", { headers: { "content-type": "image/jpeg" } });
    expect((await image("aerial/near", 0, {}, project, locationImageVersion(moved))).res.status).toBe(503);
    expect(downloads).toBe(7);

    // An old downloader cannot overwrite a new lease owner's successful refresh.
    await primary.pool.query("update projects_locations set context=$1 where project_id=$2", [JSON.stringify(context), project]);
    await primary.pool.query("update projects_location_images set fresh_until=now()-interval '1 second' where id=$1", [cached.id]);
    let releaseOld!: () => void;
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    let entered = false;
    upstream = async url => { entered = true; await oldGate; return success(url); };
    const oldRequest = image(); await waitFor(() => entered);
    await primary.pool.query("update projects_location_images set lease_until=now()-interval '1 second' where id=$1", [cached.id]);
    const newer = Buffer.concat([jpeg, Buffer.from("new-image-version")]);
    upstream = async () => new Response(newer, { headers: { "content-type": "image/jpeg" } });
    expect((await image("aerial/near", 1)).bytes).toEqual(newer);
    releaseOld(); expect((await oldRequest).bytes).toEqual(newer);
    expect((await image()).bytes).toEqual(newer);
    expect((await primary.pool.query("select count(*)::int as n from test_audit where action='projects.location_image.saved'")).rows[0].n).toBe(5);
  } finally {
    globalThis.fetch = originalFetch;
    for (const server of servers) server.close();
    const keys = await primary.pool.query("select storage_key from projects_location_images where storage_key is not null").catch(() => ({ rows: [] }));
    for (const { storage_key } of keys.rows) await fileStorage.remove(storage_key);
    await primary.pool.end(); await replica.pool.end();
    await admin.pool.query(`DROP SCHEMA ${schema} CASCADE`); await admin.pool.end();
  }
}, 30000);
