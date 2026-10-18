import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { importCountSource } from "@richtfest/public-data/traffic-count-worker";
import { trafficCountsInBox } from "@richtfest/public-data/traffic-count-queries";

const url = process.env.DATABASE_URL;
const integration = url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname) ? test : test.skip;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

integration("traffic count imports upsert by source, release and station, skip unchanged files and keep records on failure", async () => {
  const namespace = `traffic_count_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${namespace}`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${namespace}` });
  const db = drizzle(pool), raw = new Map<string, Uint8Array>();
  const original = Buffer.from(await Bun.file("richtfest-apps/public-data/src/fixtures/traffic-counts/bast-dz-2024.csv").arrayBuffer());
  let body: Buffer | null = original;
  const deps = {
    db, reportError: () => {},
    saveRaw: async (key: string, bytes: Uint8Array) => { raw.set(key, bytes); },
    fetch: (async () => body ? new Response(new Uint8Array(body)) : new Response("unavailable", { status: 503 })) as unknown as typeof fetch,
  };
  const rows = async () => (await pool.query("SELECT station_id, daily_traffic, heavy_vehicles, checksum, record_hash FROM public_data_traffic_counts ORDER BY station_id")).rows;
  const source = async () => (await pool.query("SELECT * FROM public_data_traffic_count_sources WHERE id='bast-dz-2024'")).rows[0];
  try {
    await pool.query(await Bun.file("richtfest-os/apps/api/drizzle/0054_traffic_counts.sql").text());

    const first = await importCountSource(deps, "bast-dz-2024");
    expect(first).toMatchObject({ status: "imported", release: "2024", records: 2, inserted: 2, updated: 0, removed: 0, skipped: 1 });
    expect(raw.size).toBe(1); // the retrieved file is kept as private evidence
    expect([...raw.keys()][0]).toMatch(/^[a-f0-9-]+\/[a-f0-9-]+\/[a-f0-9-]+\/[a-f0-9-]+$/);
    const initial = await rows();
    expect(initial.map(row => [row.station_id, row.daily_traffic, row.heavy_vehicles, row.checksum])).toEqual([["6310", 28387, 1029, sha(original)], ["9539", 69950, 11477, sha(original)]]);
    expect(await source()).toMatchObject({ current_release: "2024", record_count: 2, failures: 0, error: null, lease_token: null });

    // Same file: skipped by the checkpoint, nothing rewritten, no new evidence.
    expect(await importCountSource(deps, "bast-dz-2024")).toMatchObject({ status: "unchanged", records: 2 });
    expect(raw.size).toBe(1);
    // Forced re-parse of the same file is idempotent: no row changes.
    expect(await importCountSource(deps, "bast-dz-2024", { force: true })).toMatchObject({ status: "imported", inserted: 0, updated: 0, removed: 0 });
    expect(await rows()).toEqual(initial);

    // A corrected release: one count changes, one station disappears.
    const changed = original.toString("latin1").replace(";28.387;", ";28.400;").split("\n").filter(line => !/^\s*\d+;9539;/.test(line)).join("\n");
    body = Buffer.from(changed, "latin1");
    expect(changed).not.toBe(original.toString("latin1"));
    expect(await importCountSource(deps, "bast-dz-2024")).toMatchObject({ status: "imported", records: 1, inserted: 0, updated: 1, removed: 1 });
    expect((await rows()).map(row => [row.station_id, row.daily_traffic, row.checksum])).toEqual([["6310", 28400, sha(body)]]);

    // Bounding-box read returns current-release records with provenance.
    const near = await trafficCountsInBox(db, [8.72, 50.16, 8.74, 50.17]);
    expect(near).toHaveLength(1);
    expect(near[0]).toMatchObject({ sourceId: "bast-dz-2024", label: "BASt Dauerzählstellen 2024", licence: "CC BY 4.0", stationId: "6310", road: "B 521", year: 2024, dailyTraffic: 28400, heavyVehicles: 1029, specificity: 2, checksum: sha(body), geometry: { type: "Point", coordinates: [8.72957982, 50.16434712] } });
    expect(await trafficCountsInBox(db, [13.3, 52.4, 13.5, 52.6])).toEqual([]);

    // A failed retrieval keeps the published records and records only a stage message.
    body = null;
    expect(await importCountSource(deps, "bast-dz-2024")).toMatchObject({ status: "failed", error: "Traffic count retrieval failed; previous records retained" });
    expect((await rows()).map(row => row.daily_traffic)).toEqual([28400]);
    expect(await source()).toMatchObject({ failures: 1, error: "Traffic count retrieval failed; previous records retained", lease_token: null, record_count: 1 });

    const runs = (await pool.query("SELECT status, trigger, inserted, updated, removed FROM public_data_traffic_count_runs ORDER BY started_at")).rows;
    expect(runs.map(run => run.status)).toEqual(["imported", "unchanged", "imported", "imported", "failed"]);
    expect(runs.every(run => run.trigger === "manual")).toBe(true);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${namespace} CASCADE`);
    await admin.end();
  }
});
