import { expect, test } from "bun:test";
import express from "express";
import { Readable } from "node:stream";
import { createBuildingModelRouter } from "@richtfest/projects/building-model";
import { runBuildingExtraction } from "@richtfest/projects/building-extraction";
import { buildingExtractionJobs } from "@richtfest/projects/schema";
import { syntheticPlanPdf } from "../../../../richtfest-apps/projects/src/test-fixtures/synthetic-plan";
import { createDatabase } from "./db/client";

const url = process.env.BUILDING_EXTRACTION_TEST_DATABASE_URL;
const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
const poppler = Bun.spawnSync(["which", "pdftotext"]).exitCode === 0;
(local && poppler ? test : test.skip)("wall adjacency derives roles from accepted plan geometry without overriding people", async () => {
  const namespace = `building_components_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(url!); await admin.pool.query(`CREATE SCHEMA ${namespace}`);
  const isolated = new URL(url!); isolated.searchParams.set("options", `-c search_path=${namespace}`);
  const { db, pool } = createDatabase(isolated.href);
  const tenant = crypto.randomUUID(), project = crypto.randomUUID(), actor = crypto.randomUUID(), model = crypto.randomUUID(), building = crypto.randomUUID(), storey = crypto.randomUUID(), file = crypto.randomUUID(), version = crypto.randomUUID();
  const audits: string[] = [];
  const app = express(); app.use(express.json());
  app.use(createBuildingModelRouter(() => ({ db, tenantId: tenant, actorId: actor, requirePermission() {},
    audit: async (_tx: unknown, action: string) => { audits.push(action); }, validateCustomer: async () => false, customerNames: async () => ({}), fileStorage: {} as any }) as any));
  app.use((e: any, _req: any, res: any, _next: any) => res.status(e.status ?? 500).json({ message: e.message }));
  const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as any).port}/projects/${project}/building-model`;
  const post = async (path: string, body: unknown) => { const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const revision = async () => Number((await pool.query("select revision from projects_building_models")).rows[0].revision);
  try {
    for (const table of ["projects_projects", "projects_files", "projects_file_versions", "projects_source_extractions", "projects_source_models", ...(await admin.pool.query("select tablename from pg_tables where schemaname='public' and tablename like 'projects_building_%'")).rows.map(r => r.tablename)]) {
      if (!/^projects_[a-z_]+$/.test(table)) throw new Error("Unexpected test table");
      await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await pool.query("insert into projects_projects (id,tenant_id,name,created_by) values ($1,$2,'Components test',$3)", [project, tenant, actor]);
    await pool.query("insert into projects_building_models (id,tenant_id,project_id,created_by) values ($1,$2,$3,$4)", [model, tenant, project, actor]);
    await pool.query("insert into projects_building_buildings (id,tenant_id,model_id,stable_key,name,created_by) values ($1,$2,$3,'test','Test',$4)", [building, tenant, model, actor]);
    await pool.query("insert into projects_building_storeys (id,tenant_id,model_id,building_id,stable_key,name,created_by) values ($1,$2,$3,$4,'test','Test',$5)", [storey, tenant, model, building, actor]);
    await pool.query("insert into projects_files (id,tenant_id,project_id,name,source_type,created_by) values ($1,$2,$3,'plan.pdf','upload',$4)", [file, tenant, project, actor]);
    await pool.query("insert into projects_file_versions (id,tenant_id,file_id,version,status,storage_key,mime_type,created_by) values ($1,$2,$3,1,'ready','test','application/pdf',$4)", [version, tenant, file, actor]);
    await db.insert(buildingExtractionJobs).values({ tenantId: tenant, modelId: model, sourceVersionId: version, storeyId: storey, page: 1, extractorVersion: "topology-v8", createdBy: actor });
    const pdf = syntheticPlanPdf({ unitFill: true });
    expect(await runBuildingExtraction({ db, fileStorage: { read: async () => Readable.from([pdf]) }, audit: async () => {}, reportError: () => {} } as any, new AbortController().signal)).toBe(true);
    const candidates = (await pool.query("select id,name,entity_type,geometry from projects_building_extraction_candidates")).rows;
    const accepted = candidates.filter(c => c.geometry.quality === "enclosed_region" || c.geometry.quality === "draft_wall");
    for (const candidate of accepted)
      expect((await post(`/extraction-candidates/${candidate.id}/review`, { baseRevision: await revision(), decision: "approved" })).status).toBe(200);
    const rooms = new Map((await pool.query("select id,name from projects_building_rooms")).rows.map(r => [r.name, r.id]));
    expect([...rooms.keys()].sort()).toEqual(["Bad", "Flur", "Küche", "Schlafen", "Wohnen"]);

    // Typed component properties reject invalid values and units before anything is stored.
    const wall = (await pool.query("select id from projects_building_elements where kind='draft_wall' limit 1")).rows[0].id;
    const evidence = [{ kind: "page", sourceVersionId: version, page: 1 }];
    expect((await post("/properties", { baseRevision: await revision(), entityType: "element", entityId: wall, propertyKey: "thickness", value: 24, unit: "m", provenance: "manual", evidence })).status).toBe(422);
    expect((await post("/properties", { baseRevision: await revision(), entityType: "element", entityId: wall, propertyKey: "wallRole", value: "party_wall", provenance: "manual", evidence })).status).toBe(422);

    // The bedroom is declared a separate apartment: walls between it and WE 1 rooms become apartment partitions.
    expect((await post("/properties", { baseRevision: await revision(), entityType: "room", entityId: rooms.get("Schlafen"), propertyKey: "apartmentUnit", value: "WE 2", provenance: "manual", evidence })).status).toBe(201);
    expect((await post("/wall-adjacency", { baseRevision: (await revision()) - 1 })).status).toBe(409);
    const derived = await post("/wall-adjacency", { baseRevision: await revision() });
    expect(derived.status).toBe(200);
    const roles = async () => new Map((await pool.query(`select e.id, v.value, v.provenance, v.review_status from projects_building_elements e
      join projects_building_properties p on p.entity_id=e.id and p.property_key='wallRole'
      join lateral (select * from projects_building_property_versions v where v.property_id=p.id order by version desc limit 1) v on true`)).rows.map(r => [r.id, r]));
    // "A|B" per wall: rooms on each face joined by "+", faces sorted; "outside" for an exterior face, "-" for an unresolved one.
    const separated = async () => {
      const rows = (await pool.query(`select from_entity_id as wall, metadata->>'side' as side, coalesce(string_agg(r.name, '+' order by r.name), 'outside') as rooms from projects_building_relationships x
        left join projects_building_rooms r on r.id=x.to_entity_id where relationship_type in ('separates','faces_exterior') group by from_entity_id, metadata->>'side'`)).rows;
      const faces = new Map<string, string[]>();
      for (const row of rows) faces.set(row.wall, [...(faces.get(row.wall) ?? []), row.rooms]);
      return new Map([...faces].map(([id, list]) => [id, (list.length === 1 ? [...list, "-"] : list).sort().join("|")]));
    };
    const byWall = await separated();
    const wallRoles = await roles();
    const roleFor = (names: string) => [...byWall.entries()].filter(([, rooms]) => rooms === names).map(([id]) => wallRoles.get(id)?.value ?? null);
    // Synthetic plan: walls from Flur or Bad to Schlafen cross into WE 2; Küche|Wohnen stays inside WE 1.
    expect(roleFor("Bad|Schlafen")).toEqual(["apartment_partition"]);
    expect(roleFor("Küche|Wohnen")).toEqual(["internal"]);
    expect(roleFor("Flur|Schlafen")).toEqual(["apartment_partition"]);
    // One corridor wall faces both Bad (WE 1) and Schlafen (WE 2): mixed roles are left for a person.
    expect(roleFor("Bad+Schlafen|Flur")).toEqual([null]);
    // Facades: nothing lies beyond them on the sheet. The top facade runs past Wohnen and Küche.
    expect(roleFor("Küche+Wohnen|outside")).toEqual(["exterior"]);
    expect([...byWall.values()].filter(names => names.endsWith("|outside")).length).toBeGreaterThanOrEqual(3);
    // Thickness from the printed 1:100 scale: 30 cm facades and 12 cm partitions in the synthetic plan.
    const thickness = async () => new Map((await pool.query(`select p.entity_id, v.value, v.unit, v.provenance, v.evidence from projects_building_properties p
      join lateral (select * from projects_building_property_versions v where v.property_id=p.id order by version desc limit 1) v on true where p.property_key='thickness'`)).rows.map(r => [r.entity_id, r]));
    const thicknesses = await thickness();
    const thicknessFor = (names: string) => [...byWall.entries()].filter(([, rooms]) => rooms === names).map(([id]) => thicknesses.get(id)?.value);
    expect(thicknessFor("Küche|Wohnen")).toEqual([12]);
    expect(thicknessFor("Küche+Wohnen|outside")).toEqual([30]);
    expect([...thicknesses.values()].every(r => r.unit === "cm" && r.provenance === "inferred" && r.evidence[0].quote === "Printed scale 1:100")).toBe(true);
    expect(derived.body.data.summary).toMatchObject({ thicknesses: 9, thicknessProposals: 9 });
    expect([...wallRoles.values()].every(r => r.provenance === "inferred" && r.review_status === "unreviewed")).toBe(true);
    expect(derived.body.data.summary).toMatchObject({ walls: 9, roleProposals: wallRoles.size });
    const relationshipCount = async () => Number((await pool.query("select count(*) from projects_building_relationships")).rows[0].count);
    expect(derived.body.data.summary.relationships).toBe(await relationshipCount());
    expect(audits).toContain("projects.building.wall_adjacency.derived");

    // A person's entry is kept; re-running replaces derived adjacency without duplicating rows or versions.
    const kitchenWall = [...byWall.entries()].find(([, names]) => names === "Küche|Wohnen")![0];
    expect((await post("/properties", { baseRevision: await revision(), entityType: "element", entityId: kitchenWall, propertyKey: "wallRole", value: "apartment_partition", provenance: "manual", evidence })).status).toBe(201);
    const versionsBefore = Number((await pool.query("select count(*) from projects_building_property_versions")).rows[0].count);
    const rerun = await post("/wall-adjacency", { baseRevision: await revision() });
    expect(rerun.body.data.summary.roleProposals).toBe(0);
    expect(Number((await pool.query("select count(*) from projects_building_property_versions")).rows[0].count)).toBe(versionsBefore);
    expect(await separated()).toEqual(byWall);
    expect(rerun.body.data.summary.relationships).toBe(await relationshipCount());
    expect((await roles()).get(kitchenWall)).toMatchObject({ value: "apartment_partition", provenance: "manual" });

    // The architect answers per wall type: copy one apartment partition wall's data to the others.
    const bathWall = [...byWall.entries()].find(([, names]) => names === "Bad|Schlafen")![0], corridorWall = [...byWall.entries()].find(([, names]) => names === "Flur|Schlafen")![0];
    for (const [key, value, unit] of [["construction", "masonry", null], ["thickness", 24, "cm"], ["bulkDensity", 1800, "kg/m³"]] as const)
      expect((await post("/properties", { baseRevision: await revision(), entityType: "element", entityId: bathWall, propertyKey: key, value, unit, provenance: "manual", evidence })).status).toBe(201);
    expect((await post("/properties", { baseRevision: await revision(), entityType: "element", entityId: corridorWall, propertyKey: "thickness", value: 25, unit: "cm", provenance: "manual", evidence })).status).toBe(201);
    const roleless = (await pool.query("select id from projects_building_elements where id <> all($1::uuid[]) limit 1", [[...wallRoles.keys(), kitchenWall]])).rows[0]?.id;
    if (roleless) expect((await post("/component-copy", { baseRevision: await revision(), sourceElementId: roleless, keys: ["construction"] })).status).toBe(422);
    const copied = await post("/component-copy", { baseRevision: await revision(), sourceElementId: bathWall, keys: ["construction", "material", "thickness", "bulkDensity"] });
    expect(copied.status).toBe(200);
    // Targets: the corridor wall and the kitchen wall a person marked as apartment partition. The corridor wall keeps its entered 25 cm.
    expect(copied.body.data.summary).toEqual({ wallRole: "apartment_partition", targets: 2, updated: { construction: 2, thickness: 1, bulkDensity: 2 }, kept: 1 });
    const after = await thickness();
    expect(after.get(kitchenWall)).toMatchObject({ value: 24, provenance: "manual" });
    expect(after.get(corridorWall)).toMatchObject({ value: 25, provenance: "manual" });
    expect((await post("/component-copy", { baseRevision: await revision(), sourceElementId: bathWall, keys: ["construction", "thickness", "bulkDensity"] })).body.data.summary.updated).toEqual({});

    // Bulk review approves exactly the versions shown; stale or unrelated items are skipped, never approved unseen.
    const latestVersion = async (entityId: string, key: string) => (await pool.query(`select p.id as "propertyId", v.version, v.review_revision as "reviewRevision" from projects_building_properties p
      join lateral (select * from projects_building_property_versions v where v.property_id=p.id order by version desc limit 1) v on true where p.entity_id=$1 and p.property_key=$2`, [entityId, key])).rows[0];
    const shown = [await latestVersion(bathWall, "thickness"), await latestVersion(kitchenWall, "thickness")];
    const stale = { ...(await latestVersion(corridorWall, "thickness")) }; stale.version -= 1;
    // Free-form keys outside the shared component set keep their individual review path.
    expect((await post("/properties", { baseRevision: await revision(), entityType: "element", entityId: bathWall, propertyKey: "fireRating", value: "REI 90", provenance: "manual", evidence })).status).toBe(201);
    const freeForm = await latestVersion(bathWall, "fireRating");
    const bulk = await post("/properties/review", { baseRevision: await revision(), decision: "approved", items: [...shown, stale, freeForm] });
    expect(bulk.status).toBe(200); expect(bulk.body.data).toMatchObject({ reviewed: 2, skipped: 2 });
    expect((await pool.query(`select v.review_status from projects_building_property_versions v where (v.property_id, v.version) in (($1::uuid,$2::int),($3::uuid,$4::int))`, [shown[0].propertyId, shown[0].version, shown[1].propertyId, shown[1].version])).rows.map(r => r.review_status)).toEqual(["approved", "approved"]);
    const before = await revision();
    expect((await post("/properties/review", { baseRevision: before, decision: "approved", items: shown })).status).toBe(409);
    expect(await revision()).toBe(before);

    // A derived thickness is not passed on as if a person had entered it.
    const facade = [...byWall.entries()].find(([, names]) => names === "Küche+Wohnen|outside")![0];
    expect((await post("/component-copy", { baseRevision: await revision(), sourceElementId: facade, keys: ["thickness"] })).body.data.summary).toMatchObject({ wallRole: "exterior", updated: {} });

    const context = await (await fetch(base + "/agent-context")).json();
    const wallGaps = context.data.missingInputs.filter((gap: any) => gap.entityId === kitchenWall).map((gap: any) => `${gap.field}:${gap.status}`);
    expect(wallGaps).toEqual(["construction:unreviewed", "bulkDensity:unreviewed", "wallRole:unreviewed"]);
    expect(context.data.wallAdjacency.some((item: any) => item.exterior && item.roomId === null)).toBe(true);
  } finally { server.close(); await pool.end(); await admin.pool.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.pool.end(); }
}, 60000);
