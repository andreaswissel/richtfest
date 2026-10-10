import { expect, test, spyOn } from "bun:test";
import express from "express";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { seedCatalogue, berlinSources } from "@richtfest/public-data/catalogue";
import { runImport } from "@richtfest/public-data/worker";
import { readBerlinSnapshot, availableUpdates } from "@richtfest/public-data/queries";
import { createRouter } from "@richtfest/public-data";
import { createLocationRouter } from "../../../../richtfest-apps/projects/src/location-router";
import { runLocationJob } from "@richtfest/projects/location-worker";

const url = process.env.DATABASE_URL;
const integration = url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname) ? test : test.skip;
integration("public imports preserve evidence, publish complete versions, recover leases and leave project pins unchanged", async () => {
  const namespace = `public_data_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${namespace}`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${namespace}` });
  const db = drizzle(pool), raw = new Map<string, Uint8Array>();
  const signal = new AbortController().signal;
  const tree = (layer: string, id: string, height: number | null) => ({ type: "Feature", id: `${layer}.${id}`, properties: { gisid: id, baumhoehe: height, kronedurch: "0", art_dtsch: "Linde" }, geometry: { type: "Point", coordinates: [397116.74, 5824091.87] } });
  let mode = "initial", block: Promise<void> | null = null, entered: (() => void) | null = null;
  const payload = (layer: string) => {
    let features: any[] = layer === "gebaeudehoehen" ? [{ type: "Feature", id: "gebaeudehoehen.4", properties: { gml_id: "model-4", hoehe: 14.5, hnr: "20", strasse: "Giersstraße" }, geometry: { type: "Polygon", coordinates: [[[397130,5824120],[397145,5824120],[397145,5824130],[397130,5824120]]] } }]
      : [tree(layer, "a", mode === "changed" || mode === "stale" ? 17 : 9), tree(layer, "b", null)];
    if (layer === "strassenbaeume" && mode === "reordered") features.reverse();
    if (layer === "strassenbaeume" && mode === "deleted") features = features.slice(0, 1);
    if (layer === "strassenbaeume" && mode === "empty") features = [];
    if (layer === "strassenbaeume" && mode === "duplicate") features[1] = features[0];
    if (layer === "strassenbaeume" && mode === "overflow") features = Array.from({ length: 10001 }, (_, i) => tree(layer, String(i), 9));
    return { type: "FeatureCollection", features, numberMatched: features.length + (mode === "partial" ? 1 : 0), numberReturned: features.length, crs: { type: "name", properties: { name: mode === "wrong-crs" ? "EPSG:4326" : "urn:ogc:def:crs:EPSG::25833" } } };
  };
  const deps = {
    db, saveRaw: async (key: string, bytes: Uint8Array) => {
      if (mode === "storage-error") throw new Error("private diagnostic must not leak");
      raw.set(key, bytes);
    }, reportError: () => {},
    fetch: (async (url: any) => {
      const layer = new URL(String(url)).searchParams.get("typeNames")!.split(":")[1];
      const result = payload(layer);
      if (block) { entered?.(); await block; }
      if (mode === "network-error") throw new Error("private diagnostic must not leak");
      return Response.json(result);
    }) as typeof fetch,
  };
  let enabled = true;
  const tenant = crypto.randomUUID(), otherTenant = crypto.randomUUID(), project = crypto.randomUUID();
  const app = express(); app.use(express.json());
  const requirePermission = (req: express.Request) => (permission: string) => {
    if (req.headers["x-denied"] || (permission === "projects:write" && req.headers["x-read-only"])) throw Object.assign(new Error("Forbidden"), { status: 403 });
  };
  app.use("/api/public-data", createRouter(req => ({ db, enabled, canRefreshProjectContext: !req.headers["x-read-only"], requirePermission: requirePermission(req) })));
  app.use("/api", createLocationRouter(req => ({ db, tenantId: String(req.headers["x-tenant"] ?? tenant), actorId: crypto.randomUUID(), requirePermission: requirePermission(req), audit: async () => {}, validateCustomer: async () => false, customerNames: async () => ({}), fileStorage: {} as any, publicDataUpdates: ids => availableUpdates(db, ids) })));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? (error.name === "ZodError" ? 400 : 500)).json({ message: error.message }));
  const server = app.listen(0), base = `http://127.0.0.1:${(server.address() as any).port}`;
  const request = async (path: string, body?: unknown, headers?: Record<string, string>) => {
    const r = await fetch(base + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const treePartition = berlinSources[1].partitionId;
  const due = async () => { await pool.query("UPDATE public_data_partitions SET next_check_at=now()-interval '1 second' WHERE id=$1", [treePartition]); };
  const state = async () => (await pool.query("SELECT * FROM public_data_partitions WHERE id=$1", [treePartition])).rows[0];
  const locationPath = `/api/projects/${project}/location`;
  try {
    await pool.query(await Bun.file("richtfest-os/apps/api/drizzle/0029_public_data.sql").text());
    await pool.query(await Bun.file("richtfest-os/apps/api/drizzle/0023_project_locations.sql").text());
    await pool.query("CREATE TABLE projects_projects (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name text, created_by uuid, status text, customer_id uuid, created_at timestamptz)");
    await pool.query(await Bun.file("richtfest-os/apps/api/drizzle/0024_project_address.sql").text());
    await pool.query(await Bun.file("richtfest-os/apps/api/drizzle/0025_project_address_reference.sql").text());
    await pool.query("INSERT INTO projects_projects (id,tenant_id,street,postal_code,city,country) VALUES ($1,$2,'Giersstraße 20','13088','Berlin','DE')", [project, tenant]);
    await seedCatalogue(db); await seedCatalogue(db);
    await expect(readBerlinSnapshot(db)).rejects.toThrow("not ready");
    const firstCatalogue = await request("/api/public-data/datasets");
    expect(firstCatalogue.body.data.items).toHaveLength(3);
    expect(firstCatalogue.body.data.items.every((r: any) => r.stale)).toBe(true);
    expect((await request("/api/public-data/datasets", undefined, { "x-denied": "1" })).status).toBe(403);
    enabled = false;
    expect((await request("/api/public-data/datasets")).status).toBe(503);
    enabled = true;
    for (let i = 0; i < 3; i++) expect(await runImport(deps, signal)).toBe(true);
    expect(await runImport(deps, signal)).toBe(false);
    const origin: [number, number] = [397136.524413514, 5824134.603153919];
    const snapshot = (await readBerlinSnapshot(db, origin, 100))!;
    expect(snapshot.releases).toHaveLength(3);
    expect(snapshot.releases.flatMap(r => r.features)).toHaveLength(5);
    expect(await readBerlinSnapshot(db, [origin[0] + 1, origin[1]], 100)).toBeNull();
    expect(await readBerlinSnapshot(db, [origin[0] + 1000, origin[1]], 100)).toBeNull();
    const original = (await state()).current_release_id;
    const statusPath = `/api/public-data/release-status?ids=${original}`;
    const originalStatus = (await request(statusPath)).body.data;
    expect(originalStatus.canRefreshProjectContext).toBe(true);
    expect(originalStatus.items).toHaveLength(1);
    expect(originalStatus.items[0]).toMatchObject({ releaseId: original, featureCount: 2, stale: false, partition: { currentReleaseId: original, error: null } });
    expect((await request(statusPath, undefined, { "x-read-only": "1" })).body.data.canRefreshProjectContext).toBe(false);
    expect((await request(statusPath, undefined, { "x-denied": "1" })).status).toBe(403);
    expect((await request("/api/public-data/release-status?ids=invalid")).status).toBe(400);
    expect((await request(`/api/public-data/release-status?ids=${Array(21).fill(original).join(",")}`)).status).toBe(400);
    expect((await request(`/api/public-data/release-status?ids=${crypto.randomUUID()}`)).body.data.items).toEqual([]);
    expect(JSON.stringify(originalStatus)).not.toMatch(/storageKey|leaseToken/);
    enabled = false;
    expect((await request(statusPath)).status).toBe(503);
    enabled = true;
    const first = (await request(`/api/public-data/releases/${original}?limit=1`)).body.data;
    expect(first.items[0].feature).toMatchObject({ sourceId: "strassenbaeume.a", height: 9, crownDiameter: null });
    const second = (await request(`/api/public-data/releases/${original}?after=${first.nextCursor}&limit=1`)).body.data;
    expect(second.items[0].feature.sourceId).toBe("strassenbaeume.b");
    expect(second.nextCursor).toBeNull();
    expect(JSON.stringify(first)).not.toContain("storageKey");
    for (const asset of (await pool.query("SELECT * FROM public_data_assets")).rows) {
      expect(createHash("sha256").update(raw.get(asset.storage_key)!).digest("hex")).toBe(asset.checksum);
    }
    expect((await request(locationPath + "/import", { revision: 0 })).status).toBe(202);
    const geocoder = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      expect(new URL(String(input)).pathname).toEndWith("adressen_berlin");
      return Response.json({ features: [{ properties: { adressid: "61316", str_name: "Giersstraße", hnr: 20, hnr_zusatz: null, plz: "13088" }, geometry: { type: "Point", coordinates: [13.48266821,52.55754663] } }], numberMatched: 1 });
    }, { preconnect: fetch.preconnect }));
    try {
      await runLocationJob({ db, publicDataSnapshot: (origin, radius) => readBerlinSnapshot(db, origin, radius), audit: async () => {}, reportError: () => {} }, signal);
    } finally { geocoder.mockRestore(); }
    const pinned = (await request(locationPath)).body.data;
    expect(pinned.revision).toBe(1);
    expect(pinned.context.publicReleases).toHaveLength(3);
    expect(pinned.context.trees[0].position[0]).toBeLessThan(0);
    expect(pinned.context.trees[0].position[1]).toBeGreaterThan(0);
    expect(pinned.context.trees[0].publicRevisionId).toBeTruthy();
    expect((await request(locationPath, undefined, { "x-tenant": otherTenant })).status).toBe(404);
    expect((await request(locationPath + "/import", { revision: 1, refresh: true }, { "x-read-only": "1" })).status).toBe(403);
    expect((await request(locationPath + "/import", { revision: 0, refresh: true })).status).toBe(409);
    await pool.query("UPDATE projects_projects SET street='Giersstraße 21' WHERE id=$1", [project]);
    expect((await request(locationPath + "/import", { revision: 1, refresh: true })).status).toBe(409);
    await pool.query("UPDATE projects_projects SET street='Giersstraße 20' WHERE id=$1", [project]);

    mode = "reordered"; await due(); await runImport(deps, signal);
    expect((await state()).current_release_id).toBe(original);
    expect((await pool.query("SELECT count(*)::int AS n FROM public_data_revisions")).rows[0].n).toBe(5);
    for (mode of ["partial", "duplicate", "wrong-crs", "overflow", "network-error", "storage-error"]) {
      await due(); await runImport(deps, signal);
      const failed = await state();
      expect(failed.current_release_id).toBe(original);
      expect(failed.failures).toBeGreaterThan(0);
      expect(failed.next_check_at.getTime()).toBeGreaterThan(Date.now());
      expect(failed.error).not.toContain("private diagnostic");
    }
    await pool.query("UPDATE public_data_partitions SET last_success_at=now()-interval '2 days' WHERE id=$1", [treePartition]);
    const failedStatus = (await request(statusPath)).body.data.items[0];
    expect(failedStatus.stale).toBe(true);
    expect(failedStatus.partition.error).toBeTruthy();
    expect(failedStatus.partition.currentReleaseId).toBe(original);
    await pool.query("UPDATE public_data_datasets SET metadata=jsonb_set(metadata, '{sourceUpdatedAt}', '\"2026-10-11\"') WHERE id=$1", [berlinSources[1].id]);
    mode = "changed"; await due(); await runImport(deps, signal);
    const changed = (await state()).current_release_id;
    expect(changed).not.toBe(original);
    const oldPinStatus = (await request(statusPath)).body.data.items[0];
    expect(oldPinStatus).toMatchObject({ releaseId: original, checksum: originalStatus.items[0].checksum, metadata: originalStatus.items[0].metadata, retrievedAt: originalStatus.items[0].retrievedAt, partition: { currentReleaseId: changed, error: null }, stale: false });
    const current = (await request(`/api/public-data/releases/${changed}`)).body.data;
    expect(current.items[0].feature.height).toBe(17);
    expect(current.items[1].revisionId).toBe(second.items[0].revisionId);
    expect((await request(`/api/public-data/releases/${original}`)).body.data.items[0].feature.height).toBe(9);
    const afterChange = (await request(locationPath)).body.data;
    expect(afterChange.context).toEqual(pinned.context);
    expect(afterChange.availableContextUpdates).toEqual([{ partitionId: treePartition, pinnedReleaseId: original, latestReleaseId: changed }]);
    const scene = { objects: [{ id: "planning-note", kind: "note", label: "Keep", position: [1, 2, 3], size: [0, 0, 0], rotation: 0, note: "Check on site" }], planningNotes: "Preserve planning decisions" };
    await pool.query("UPDATE projects_locations SET scene=$1 WHERE project_id=$2", [JSON.stringify(scene), project]);
    // Ordinary repeated imports cannot silently replace project evidence.
    await request(locationPath + "/import", { revision: 1 });
    expect(await runLocationJob({ db, publicDataSnapshot: () => readBerlinSnapshot(db), audit: async () => {}, reportError: () => {} }, signal)).toBe(false);
    await request(locationPath + "/import", { revision: 1, refresh: true });
    await runLocationJob({ db, publicDataSnapshot: async () => { throw new Error("unavailable"); }, audit: async () => {}, reportError: () => {} }, signal);
    const failedRefresh = (await request(locationPath)).body.data;
    expect(failedRefresh.contextJob.status).toBe("failed");
    expect(failedRefresh.context).toEqual(pinned.context);
    expect(failedRefresh.scene).toEqual(scene);
    await request(locationPath + "/import", { revision: 1, refresh: true });
    await runLocationJob({ db, audit: async () => {}, reportError: () => {} }, signal);
    const disabledRefresh = (await request(locationPath)).body.data;
    expect(disabledRefresh.contextJob.status).toBe("failed");
    expect(disabledRefresh.context).toEqual(pinned.context);
    await request(locationPath + "/import", { revision: 1, refresh: true });
    await runLocationJob({ db, publicDataSnapshot: (origin, radius) => readBerlinSnapshot(db, origin, radius), audit: async () => {}, reportError: () => {} }, signal);
    const refreshed = (await request(locationPath)).body.data;
    expect(refreshed.availableContextUpdates).toEqual([]);
    expect(refreshed.scene).toEqual(scene);
    expect(refreshed.revision).toBe(1);
    expect(refreshed.context.origin).toEqual(pinned.context.origin);
    expect(refreshed.context.trees.find((t: any) => t.sourceId === "strassenbaeume.a").height).toBe(17);

    // Another worker cannot claim an active lease; a recovered worker fences late results.
    mode = "stale"; await due();
    let unblock!: () => void, signalEntered!: () => void;
    block = new Promise<void>(resolve => { unblock = resolve; });
    const started = new Promise<void>(resolve => { signalEntered = resolve; }); entered = signalEntered;
    const slow = runImport(deps, signal); await started;
    expect(await runImport(deps, signal)).toBe(false);
    await pool.query("UPDATE public_data_partitions SET lease_until=now()-interval '1 second' WHERE id=$1", [treePartition]);
    block = null; mode = "deleted";
    await runImport(deps, signal);
    const recovered = (await state()).current_release_id;
    unblock(); await slow;
    expect((await state()).current_release_id).toBe(recovered);
    expect((await request(`/api/public-data/releases/${recovered}`)).body.data.items).toHaveLength(1);
    expect((await request(`/api/public-data/releases/${original}`)).body.data.items).toHaveLength(2);
    const history = (await request(`/api/public-data/partitions/${treePartition}/runs`)).body.data.items;
    expect(history.some((r: any) => r.status === "interrupted")).toBe(true);
    expect(history.some((r: any) => r.status === "unchanged")).toBe(true);
    mode = "empty"; await due(); await runImport(deps, signal);
    expect((await request(`/api/public-data/releases/${(await state()).current_release_id}`)).body.data.items).toEqual([]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.end();
    await admin.query(`DROP SCHEMA ${namespace} CASCADE`);
    await admin.end();
  }
}, 30000);
