import { expect, test } from "bun:test";
import { clearHeightMetres, fireHeightMetres, type PlanHeightObservation } from "@richtfest/shared/plan-heights";
import { readPlanHeightOutput, selectHeightPages } from "./plan-heights";

const height: PlanHeightObservation = { kind: "fire_height", value: 954, unit: "cm", unitBasis: "explicit",
  quote: "Höhe 954 cm", buildingLabel: "Haus B", storeyLabel: "DG", upperReference: "highest_habitable_floor",
  lowerReference: "mean_terrain", floorBasis: "structural", constructionState: "proposed",
  region: { x: .7, y: .2, width: .2, height: .5 }, reason: "Printed dimension with labelled endpoints." };

test("height observations retain source numbers and distinguish classification height from roof and datum levels", () => {
  const output = readPlanHeightOutput({ observations: [height, { ...height, kind: "ridge_height", value: 13.8, unit: "m", quote: "First 13,80 m", upperReference: "ridge" }], gaps: [] },
    "Schnitt B-B\nHöhe 954 cm\nFirst 13,80 m");
  expect(output.observations.map(item => [item.kind, item.value, item.unit])).toEqual([["fire_height", 954, "cm"], ["ridge_height", 13.8, "m"]]);
  expect(fireHeightMetres(output.observations[0]!)).toBe(9.54);
  expect(fireHeightMetres(output.observations[1]!)).toBeNull();
  for (const patch of [{ lowerReference: "project_datum" }, { lowerReference: "terrain" }, { floorBasis: "unknown" },
    { upperReference: "floor" }, { unit: "unknown" }, { unitBasis: "unknown" }, { value: -1 }])
    expect(fireHeightMetres({ ...height, ...patch } as PlanHeightObservation)).toBeNull();
  // A number elsewhere on a sheet cannot justify an invented quote or arithmetic result.
  const rejected = readPlanHeightOutput({ observations: [{ ...height, quote: "Höhe 955 cm" }, { ...height, value: 9.54 }], gaps: [] }, "Höhe 954 cm");
  expect(rejected.observations).toEqual([]);
  expect(rejected.gaps[0]).toContain("2 observations rejected");
  expect(readPlanHeightOutput({ observations: [{ ...height, value: 9.54, quote: "9.54" }], gaps: [] }, "19.54 -9.54 9.543").observations).toEqual([]);
  expect(() => readPlanHeightOutput({ observations: [{ ...height, region: { x: .9, y: 0, width: .2, height: .5 } }], gaps: [] }, "Höhe 954 cm")).toThrow();
});

test("layout whitespace does not invalidate height evidence or relax literal source matching", () => {
  const quote = `OKFFB DG\n${" ".repeat(700)}+9.24`;
  const observation = { ...height, kind: "floor_elevation", value: 9.24, unit: "m", quote, upperReference: "floor", lowerReference: "project_datum" };
  const result = readPlanHeightOutput({ observations: [observation], gaps: [] }, quote);
  expect(result.observations[0]?.quote).toBe("OKFFB DG +9.24");
  expect(fireHeightMetres(result.observations[0]!)).toBeNull();
  expect(readPlanHeightOutput({ observations: [observation], gaps: [] }, "OKFFB EG +9.24").observations).toEqual([]);
  expect(() => readPlanHeightOutput({ observations: [{ ...observation, quote: "a".repeat(501) }], gaps: [] }, "a".repeat(501))).toThrow();
});

test("height page selection excludes floor-plan cut markers and reports bounded omitted section coverage", () => {
  const selected = selectHeightPages([{ page: 1, text: "Grundriss EG Schnitt A-A" }, { page: 2, text: "Lageplan" },
    ...Array.from({ length: 8 }, (_, i) => ({ page: i + 3, text: i === 0 ? "Ansicht Nord" : "Schnitt A-A" }))], [1]);
  expect(selected.selected.map(page => page.page)).toEqual([3, 4, 5, 6, 7, 8]);
  expect(selected.omittedPages).toEqual([9, 10]);
  expect(selectHeightPages([{ page: 1, text: "" }], [], [{ page: 1, status: "completed", answers: { page_type: { choice: "section", confidence: .59 } } }]).selected).toEqual([]);
});

const clearHeight: PlanHeightObservation = { ...height, kind: "clear_height", value: 275, quote: "Lichte Höhe 275 cm",
  upperReference: "ceiling", lowerReference: "floor", floorBasis: "finished" };

test("clear-height eligibility requires a positive finished floor-to-ceiling observation, never approval", () => {
  expect(clearHeightMetres(clearHeight)).toBe(2.75);
  expect(clearHeightMetres({ ...clearHeight, value: 2750, unit: "mm", unitBasis: "drawing_convention" })).toBe(2.75);
  expect(clearHeightMetres({ ...clearHeight, value: 2.75, unit: "m" })).toBe(2.75);
  expect(clearHeightMetres({ ...clearHeight, value: 1500, unit: "mm" })).toBe(1.5);
  expect(clearHeightMetres({ ...clearHeight, value: 2000, unit: "cm" })).toBe(20);
  for (const patch of [{ kind: "fire_height" }, { kind: "floor_elevation" }, { upperReference: "floor" }, { upperReference: "unknown" },
    { lowerReference: "project_datum" }, { lowerReference: "unknown" }, { floorBasis: "structural" }, { floorBasis: "unknown" },
    { unit: "unknown" }, { unitBasis: "unknown" }, { value: 0 }, { value: -1 }, { value: NaN }, { value: Infinity },
    { value: 1.49, unit: "m" }, { value: 20.01, unit: "m" }, { value: 1499, unit: "mm" }])
    expect(clearHeightMetres({ ...clearHeight, ...patch } as PlanHeightObservation)).toBeNull();
  expect(fireHeightMetres(clearHeight)).toBeNull();
  expect(clearHeightMetres(height)).toBeNull();
  const saved = readPlanHeightOutput({ observations: [clearHeight], gaps: [] }, clearHeight.quote);
  expect(saved.observations).toEqual([clearHeight]);
  // Unknown building/storey/state is not resolved by transfer eligibility.
  expect(clearHeightMetres({ ...clearHeight, buildingLabel: null, storeyLabel: null, constructionState: "unknown" })).toBe(2.75);
});

const databaseUrl = process.env.BUILDING_EXTRACTION_TEST_DATABASE_URL;
const localDatabase = databaseUrl && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(databaseUrl).hostname);

(localDatabase ? test : test.skip)("saved clear-height API proposes exactly one room, preserves evidence and rejects unsafe transfers without writes", async () => {
  // Opt-in, isolated schema: copy table definitions only, never customer rows or provider configuration.
  const { createRequire } = await import("node:module");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { sql } = await import("drizzle-orm");
  const { default: express } = await import("express");
  const { createBuildingModelRouter } = await import("./building-model-router");
  // Resolve Drizzle's optional PostgreSQL peer alongside the driver, not OS application code.
  const { Pool } = createRequire(import.meta.resolve("drizzle-orm/node-postgres"))("pg");
  const namespace = `clear_height_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${namespace}`);
  const isolated = new URL(databaseUrl!); isolated.searchParams.set("options", `-c search_path=${namespace}`);
  const pool = new Pool({ connectionString: isolated.href }), db = drizzle(pool);
  const tenant = crypto.randomUUID(), otherTenant = crypto.randomUUID(), project = crypto.randomUUID(), actor = crypto.randomUUID(),
    model = crypto.randomUUID(), otherModel = crypto.randomUUID(), building = crypto.randomUUID(), storey = crypto.randomUUID(),
    file = crypto.randomUUID(), source = crypto.randomUUID(), otherSource = crypto.randomUUID(), room = crypto.randomUUID(), neighbour = crypto.randomUUID();
  const geometry = { source: { sourceVersionId: source, page: 1 }, polygon: [{ x: .1, y: .1 }, { x: .5, y: .1 }, { x: .5, y: .5 }] };
  const invalidObservations = [{ ...clearHeight, upperReference: "unknown" }, { ...clearHeight, floorBasis: "structural" },
    { ...clearHeight, unitBasis: "unknown" }, { ...clearHeight, value: 0 }, { ...clearHeight, kind: "ridge_height" },
    { ...clearHeight, lowerReference: "unknown" }, { ...clearHeight, unit: "unknown" }, { ...clearHeight, value: -2 },
    { ...clearHeight, value: 149, quote: "Lichte Höhe 149 cm" }, { ...clearHeight, value: 2001, quote: "Lichte Höhe 2001 cm" }];
  const metadata = { automaticBuildingModel: { modelId: model }, heightExtraction: { version: "section-heights-v2", status: "complete", pages: [
    { page: 2, status: "completed", observations: [clearHeight, height, ...invalidObservations], gaps: [], metadata: { provider: "synthetic", model: "no-provider-called" } },
    { page: 3, status: "failed", observations: [clearHeight], gaps: [] },
  ] } };
  const app = express(); app.use(express.json());
  app.use(createBuildingModelRouter(req => ({ db, tenantId: req.headers["x-other"] ? otherTenant : tenant, actorId: actor,
    requirePermission() { if (req.headers["x-denied"]) throw Object.assign(new Error("Forbidden"), { status: 403 }); },
    audit: async (tx, action, _type, _id, receipt) => {
      await tx.execute(sql`insert into height_audit (action, receipt) values (${action}, ${JSON.stringify(receipt)}::jsonb)`);
      if (req.headers["x-audit-fail"]) throw new Error("Synthetic audit failure");
    },
    validateCustomer: async () => false, customerNames: async () => ({}), fileStorage: {} as any })));
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? (error.name === "ZodError" ? 422 : 500)).json({ message: error.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}/projects/${project}/building-model`;
  const post = async (body: unknown, headers = {}) => {
    const response = await fetch(`${base}/height-observations`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const selection = { baseRevision: 0, roomId: room, confirmRoomApplicability: true, sourceVersionId: source, page: 2, observationIndex: 0 };
  const noWrites = async () => {
    expect((await pool.query("select revision from projects_building_models where id=$1", [model])).rows[0].revision).toBe(0);
    for (const table of ["projects_building_properties", "projects_building_property_versions", "projects_building_revisions", "height_audit"])
      expect((await pool.query(`select count(*)::int n from ${table}`)).rows[0].n).toBe(0);
  };
  try {
    for (const table of ["projects_projects", "projects_files", "projects_file_versions", "projects_source_models", "projects_building_models",
      "projects_building_buildings", "projects_building_storeys", "projects_building_rooms", "projects_building_plan_sources",
      "projects_building_superseded_sources", "projects_building_properties", "projects_building_property_versions", "projects_building_conflicts", "projects_building_revisions"])
      await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    await pool.query("create table height_audit (action text, receipt jsonb)");
    await pool.query("insert into projects_projects (id,tenant_id,name,created_by) values ($1,$2,'Synthetic height test',$3)", [project, tenant, actor]);
    await pool.query("insert into projects_building_models (id,tenant_id,project_id,created_by) values ($1,$2,$3,$4)", [model, tenant, project, actor]);
    await pool.query("insert into projects_building_buildings (id,tenant_id,model_id,stable_key,name,construction_state,created_by) values ($1,$2,$3,'b','Haus B','unknown',$4)", [building, tenant, model, actor]);
    await pool.query("insert into projects_building_storeys (id,tenant_id,model_id,building_id,stable_key,name,created_by) values ($1,$2,$3,$4,'dg','DG',$5)", [storey, tenant, model, building, actor]);
    for (const target of [room, neighbour]) await pool.query("insert into projects_building_rooms (id,tenant_id,model_id,storey_id,stable_key,name,construction_state,geometry,created_by) values ($1::uuid,$2,$3,$4,$1::text,'Room','proposed',$5,$6)", [target, tenant, model, storey, JSON.stringify(geometry), actor]);
    await pool.query("insert into projects_files (id,tenant_id,project_id,name,source_type,created_by) values ($1,$2,$3,'synthetic.pdf','upload',$4)", [file, tenant, project, actor]);
    await pool.query("insert into projects_file_versions (id,tenant_id,file_id,version,status,storage_key,mime_type,created_by) values ($1,$2,$3,1,'ready','synthetic','application/pdf',$4)", [source, tenant, file, actor]);
    await pool.query("insert into projects_source_models (version_id,tenant_id,status,metadata) values ($1,$2,'complete',$3)", [source, tenant, JSON.stringify(metadata)]);
    await pool.query("insert into projects_building_plan_sources (tenant_id,model_id,storey_id,source_version_id,page,created_by) values ($1,$2,$3,$4,1,$5),($1,$2,null,$4,2,$5)", [tenant, model, storey, source, actor]);
    // Another ready, registered revision in the same model is still not this room's source.
    await pool.query("insert into projects_file_versions (id,tenant_id,file_id,version,status,storage_key,mime_type,created_by) values ($1,$2,$3,2,'ready','synthetic-other','application/pdf',$4)", [otherSource, tenant, file, actor]);
    await pool.query("insert into projects_source_models (version_id,tenant_id,status,metadata) values ($1,$2,'complete',$3)", [otherSource, tenant, JSON.stringify(metadata)]);
    await pool.query("insert into projects_building_plan_sources (tenant_id,model_id,storey_id,source_version_id,page,created_by) values ($1,$2,$3,$4,1,$5)", [tenant, model, storey, otherSource, actor]);

    expect((await post(selection, { "x-other": "1" })).status).toBe(404);
    expect((await post(selection, { "x-denied": "1" })).status).toBe(403);
    for (const patch of [{ confirmRoomApplicability: false }, { confirmRoomApplicability: undefined }, { roomId: undefined }, { roomId: [room, neighbour] },
      { buildingId: building }, { storeyId: storey }, { value: 9 }, { reviewStatus: "approved" }, { sourceVersionId: otherSource },
      { roomId: crypto.randomUUID() }, { roomId: storey }, { page: 3 }, { page: 99 }, { observationIndex: 11 },
      ...Array.from({ length: invalidObservations.length + 1 }, (_, i) => ({ observationIndex: i + 1 }))]) {
      expect((await post({ ...selection, ...patch })).status).toBe(422);
      await noWrites();
    }
    expect((await post({ ...selection, baseRevision: 3 })).body.error.code).toBe("revision_conflict");
    // Target identity, geometry source, plan registration and all parent scopes are authoritative.
    for (const [table, column, invalid, valid] of [
      ["projects_building_rooms", "model_id", otherModel, model], ["projects_building_rooms", "tenant_id", otherTenant, tenant],
      ["projects_building_storeys", "model_id", otherModel, model], ["projects_building_buildings", "model_id", otherModel, model],
      ["projects_building_rooms", "construction_state", "demolished", "proposed"], ["projects_building_rooms", "construction_state", "existing", "proposed"],
      ["projects_building_storeys", "construction_state", "existing", "unknown"], ["projects_building_buildings", "construction_state", "demolished", "unknown"],
      ["projects_files", "project_id", crypto.randomUUID(), project], ["projects_file_versions", "status", "pending", "ready"],
      ["projects_file_versions", "mime_type", "application/x-step", "application/pdf"],
      ["projects_building_plan_sources", "model_id", otherModel, model], ["projects_building_plan_sources", "storey_id", crypto.randomUUID(), storey],
    ]) {
      await pool.query(`update ${table} set ${column}=$1`, [invalid]);
      expect((await post(selection)).status).toBe(422);
      await noWrites();
      await pool.query(`update ${table} set ${column}=$1`, [valid]);
    }
    for (const invalid of [null, {}, { source: { sourceVersionId: otherSource, page: 1 } }, { source: { sourceVersionId: source, page: 99 } },
      { source: { sourceVersionId: source, kind: "ifc", expressId: 42, page: 1 } }]) {
      await pool.query("update projects_building_rooms set geometry=$1", [JSON.stringify(invalid)]);
      expect((await post(selection)).status).toBe(422); await noWrites();
    }
    await pool.query("update projects_building_rooms set geometry=$1", [JSON.stringify(geometry)]);
    await pool.query("update projects_source_models set metadata=jsonb_set(metadata,'{automaticBuildingModel,modelId}',to_jsonb($1::text))", [otherModel]);
    expect((await post(selection)).status).toBe(422); await noWrites();
    await pool.query("update projects_source_models set metadata=$1", [JSON.stringify(metadata)]);
    await pool.query("insert into projects_building_superseded_sources (tenant_id,model_id,source_version_id,created_by) values ($1,$2,$3,$4)", [tenant, model, source, actor]);
    expect((await post(selection)).status).toBe(422); await noWrites();
    await pool.query("delete from projects_building_superseded_sources");
    await pool.query("insert into projects_building_conflicts (tenant_id,model_id,entity_type,entity_id,property_key,claims,created_by) values ($1,$2,'room',$3,'clearRoomHeight','[]',$4)", [tenant, model, room, actor]);
    expect((await post(selection)).body.error.code).toBe("height_exists"); await noWrites();
    await pool.query("delete from projects_building_conflicts");

    expect((await post(selection, { "x-audit-fail": "1" })).status).toBe(500); await noWrites();
    const attempts = await Promise.all([post(selection), post(selection)]);
    expect(attempts.map(attempt => attempt.status).sort()).toEqual([201, 409]);
    const proposed = attempts.find(attempt => attempt.status === 201)!;
    expect(proposed.status).toBe(201);
    expect(proposed.body.data.property).toMatchObject({ entityType: "room", entityId: room, propertyKey: "clearRoomHeight", claimKind: "observed_fact" });
    expect(proposed.body.data.version).toMatchObject({ version: 1, value: 2.75, unit: "m", provenance: "inferred", reviewStatus: "unreviewed", reviewedBy: null,
      evidence: [{ kind: "page", sourceVersionId: source, page: 2, quote: clearHeight.quote, region: clearHeight.region }] });
    const receipt = (await pool.query("select receipt from height_audit")).rows[0].receipt;
    expect(receipt).toMatchObject({ observation: clearHeight, inference: { provider: "synthetic" }, target: { roomId: room, storeyId: storey, buildingId: building,
      geometrySource: geometry.source, confirmRoomApplicability: true, reviewStatus: "unreviewed" } });
    expect((await pool.query("select entity_id from projects_building_properties")).rows).toEqual([{ entity_id: room }]);
    expect((await pool.query("select status from projects_building_revisions")).rows).toEqual([{ status: "draft" }]);
    // Every saved property blocks transfer, irrespective of review state, conflict or JSON-null value.
    for (const state of ["unreviewed", "approved", "rejected", "superseded"]) {
      await pool.query("update projects_building_property_versions set review_status=$1", [state]);
      expect((await post({ ...selection, baseRevision: 1 })).body.error.code).toBe("height_exists");
    }
    await pool.query("update projects_building_property_versions set value='null'::jsonb");
    expect((await post({ ...selection, baseRevision: 1 })).body.error.code).toBe("height_exists");
    await pool.query("delete from projects_building_property_versions");
    expect((await post({ ...selection, baseRevision: 1 })).body.error.code).toBe("height_exists");
    expect((await pool.query("select revision from projects_building_models")).rows[0].revision).toBe(1);
    expect((await pool.query("select count(*)::int n from height_audit")).rows[0].n).toBe(1);
    // The legacy payload still creates exactly the original building-level fire height.
    const fire = { baseRevision: 1, buildingId: building, sourceVersionId: source, page: 2, observationIndex: 1 };
    const fireResult = await post(fire);
    expect(fireResult.status).toBe(201);
    expect(fireResult.body.data.property).toMatchObject({ entityType: "building", entityId: building, propertyKey: "fireHeight" });
    expect(fireResult.body.data.version).toMatchObject({ value: 9.54, reviewStatus: "unreviewed", evidence: [{ kind: "page", sourceVersionId: source, page: 2, quote: height.quote }] });
    expect((await post({ ...fire, baseRevision: 2 })).body.error.code).toBe("height_exists");
    // Unknown source associations remain unreviewed even after the user's explicit room confirmation.
    metadata.heightExtraction.pages[0]!.observations[0] = { ...clearHeight, buildingLabel: null, storeyLabel: null, constructionState: "unknown" };
    await pool.query("update projects_source_models set metadata=$1", [JSON.stringify(metadata)]);
    const uncertain = await post({ ...selection, roomId: neighbour, baseRevision: 2 });
    expect(uncertain.status).toBe(201);
    expect(uncertain.body.data.version.reviewStatus).toBe("unreviewed");
    expect((await pool.query("select receipt from height_audit order by receipt->>'modelRevision' desc limit 1")).rows[0].receipt.observation)
      .toMatchObject({ buildingLabel: null, storeyLabel: null, constructionState: "unknown" });
    // Exact property-spec boundaries are transferable after conversion, without relaxing the range.
    for (const [value, metres, baseRevision] of [[150, 1.5, 3], [2000, 20, 4]]) {
      const target = crypto.randomUUID();
      await pool.query("insert into projects_building_rooms (id,tenant_id,model_id,storey_id,stable_key,name,construction_state,geometry,created_by) values ($1::uuid,$2,$3,$4,$1::text,'Boundary room','proposed',$5,$6)", [target, tenant, model, storey, JSON.stringify(geometry), actor]);
      metadata.heightExtraction.pages[0]!.observations[0] = { ...clearHeight, value, quote: `Lichte Höhe ${value} cm` };
      await pool.query("update projects_source_models set metadata=$1", [JSON.stringify(metadata)]);
      const boundary = await post({ ...selection, roomId: target, baseRevision });
      expect(boundary.status).toBe(201);
      expect(boundary.body.data.version).toMatchObject({ value: metres, unit: "m", reviewStatus: "unreviewed" });
      expect((await pool.query("select value from projects_building_property_versions where property_id=$1", [boundary.body.data.property.id])).rows[0].value).toBe(metres);
    }
  } finally {
    server.close(); await pool.end(); await admin.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.end();
  }
}, 60000);
