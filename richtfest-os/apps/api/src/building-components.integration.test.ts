import { expect, test } from "bun:test";
import express from "express";
import { Readable } from "node:stream";
import { createBuildingModelRouter } from "@richtfest/projects/building-model";
import { createInquiriesRouter } from "@richtfest/projects/inquiries";
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
  const deps = () => ({ db, tenantId: tenant, actorId: actor, requirePermission() {},
    audit: async (_tx: unknown, action: string) => { audits.push(action); }, validateCustomer: async () => false, customerNames: async () => ({}), fileStorage: {} as any }) as any;
  app.use(createBuildingModelRouter(deps)); app.use(createInquiriesRouter(deps));
  app.use((e: any, _req: any, res: any, _next: any) => res.status(e.status ?? 500).json({ message: e.message }));
  const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as any).port}/projects/${project}/building-model`;
  const post = async (path: string, body: unknown, method = "POST", root = base) => { const r = await fetch(root + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const inquiriesBase = base.replace(/\/building-model$/, "/inquiries");
  const revision = async () => Number((await pool.query("select revision from projects_building_models")).rows[0].revision);
  try {
    for (const table of ["projects_projects", "projects_files", "projects_file_versions", "projects_source_extractions", "projects_source_models", "projects_source_pages", "projects_inquiries", "projects_inquiry_entries", ...(await admin.pool.query("select tablename from pg_tables where schemaname='public' and tablename like 'projects_building_%'")).rows.map(r => r.tablename)]) {
      if (!/^projects_[a-z_]+$/.test(table)) throw new Error("Unexpected test table");
      await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await pool.query("insert into projects_projects (id,tenant_id,name,created_by) values ($1,$2,'Components test',$3)", [project, tenant, actor]);
    await pool.query("insert into projects_building_models (id,tenant_id,project_id,created_by) values ($1,$2,$3,$4)", [model, tenant, project, actor]);
    await pool.query("insert into projects_building_buildings (id,tenant_id,model_id,stable_key,name,created_by) values ($1,$2,$3,'test','Test',$4)", [building, tenant, model, actor]);
    await pool.query("insert into projects_building_storeys (id,tenant_id,model_id,building_id,stable_key,name,created_by) values ($1,$2,$3,$4,'test','Test',$5)", [storey, tenant, model, building, actor]);
    await pool.query("insert into projects_files (id,tenant_id,project_id,name,source_type,created_by) values ($1,$2,$3,'plan.pdf','upload',$4)", [file, tenant, project, actor]);
    await pool.query("insert into projects_file_versions (id,tenant_id,file_id,version,status,storage_key,mime_type,created_by) values ($1,$2,$3,1,'ready','test','application/pdf',$4)", [version, tenant, file, actor]);
    // The page's printed title names the storey.
    await pool.query("insert into projects_building_plan_sources (tenant_id,model_id,storey_id,source_version_id,page,created_by) values ($1,$2,$3,$4,1,$5)", [tenant, model, storey, version, actor]);
    await pool.query("insert into projects_source_pages (version_id,tenant_id,page,content) values ($1,$2,1,$3)", [version, tenant, JSON.stringify({ status: "available", text: "Wohnen\nGrundriss EG\nOKFF 1. OG +2,95\nM 1:100" })]);
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
    // The storey gets one ceiling over all its rooms; the plan has no storey above, so none is linked.
    expect(derived.body.data.summary).toMatchObject({ storeyLevels: 1, levelProposals: 1, ceilings: 1, ceilingsCreated: 1 });
    const level = (await pool.query(`select v.value, v.provenance, v.evidence from projects_building_properties p join projects_building_property_versions v on v.property_id=p.id where p.entity_type='storey' and p.property_key='level'`)).rows;
    expect(level).toEqual([{ value: 0, provenance: "inferred", evidence: [{ kind: "page", sourceVersionId: version, page: 1, quote: "Grundriss EG" }] }]);
    const ceiling = (await pool.query("select id, storey_id, geometry from projects_building_elements where kind='draft_ceiling'")).rows;
    expect(ceiling).toHaveLength(1); expect(ceiling[0].storey_id).toBe(storey);
    const covered = async () => (await pool.query("select relationship_type, to_entity_id from projects_building_relationships where from_entity_id=$1", [ceiling[0].id])).rows;
    expect((await covered()).map(r => r.relationship_type)).toEqual(Array(5).fill("covers"));
    expect(new Set((await covered()).map(r => r.to_entity_id))).toEqual(new Set(rooms.values()));

    // A person's entry is kept; re-running replaces derived adjacency without duplicating rows or versions.
    const kitchenWall = [...byWall.entries()].find(([, names]) => names === "Küche|Wohnen")![0];
    expect((await post("/properties", { baseRevision: await revision(), entityType: "element", entityId: kitchenWall, propertyKey: "wallRole", value: "apartment_partition", provenance: "manual", evidence })).status).toBe(201);
    const versionsBefore = Number((await pool.query("select count(*) from projects_building_property_versions")).rows[0].count);
    const rerun = await post("/wall-adjacency", { baseRevision: await revision() });
    expect(rerun.body.data.summary.roleProposals).toBe(0);
    expect(rerun.body.data.summary).toMatchObject({ levelProposals: 0, ceilings: 1, ceilingsCreated: 0 });
    expect((await pool.query("select count(*) from projects_building_elements where kind='draft_ceiling'")).rows[0].count).toBe("1");
    expect(await covered()).toHaveLength(5);
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

    // The agreed requirement level is a reviewed property of the building.
    expect((await post("/properties", { baseRevision: await revision(), entityType: "building", entityId: building, propertyKey: "soundInsulationLevel", claimKind: "requirement", value: "louder", provenance: "manual" })).status).toBe(422);
    expect((await post("/properties", { baseRevision: await revision(), entityType: "building", entityId: building, propertyKey: "soundInsulationLevel", claimKind: "requirement", value: "elevated", provenance: "manual" })).status).toBe(201);

    expect((await post("/properties", { baseRevision: await revision(), entityType: "building", entityId: building, propertyKey: "federalState", claimKind: "requirement", value: "XX", provenance: "manual" })).status).toBe(422);
    expect((await post("/properties", { baseRevision: await revision(), entityType: "building", entityId: building, propertyKey: "bebauungsplan", claimKind: "requirement", value: "applies", provenance: "manual" })).status).toBe(201);

    const context = await (await fetch(base + "/agent-context")).json();
    const sound = context.data.soundInsulation;
    expect(sound.requirementLevel).toEqual({ value: "elevated", reviewStatus: "unreviewed" });
    expect(sound.regulatoryBasis.bebauungsplan).toEqual({ value: "applies", reviewStatus: "unreviewed" });
    expect(sound.regulatoryBasis.gaps.map((gap: any) => `${gap.field}:${gap.status}`)).toEqual(["federalState:missing", "bebauungsplan:unreviewed", "bebauungsplanNoise:missing", "stateBuildingCodeEdition:missing", "vvtbEdition:missing", "din4109Edition:missing"]);
    expect(sound.calculation.available).toBe(false);
    // Apartment partitions (3 walls incl. the kitchen wall a person marked) and the ceiling need verifying; none is complete yet.
    expect(sound.checks).toMatchObject({ total: [...(await roles()).values()].filter(r => ["apartment_partition", "corridor_partition", "stairwell"].includes(r.value)).length + 1, ready: 0 });
    const ceilingRequest = sound.dataRequest.find((group: any) => group.componentType === "ceiling");
    expect(ceilingRequest).toMatchObject({ count: 1, componentIds: [ceiling[0].id] });
    expect(ceilingRequest.fields).toEqual(["construction", "thickness", "bulkDensity"].map(field => ({ field, missing: 1, unconfirmed: [] })));
    const partitionRequest = sound.dataRequest.find((group: any) => group.wallRole === "apartment_partition");
    // Bathroom and kitchen thickness are approved; only the corridor wall's entered 25 cm still needs confirming.
    expect(partitionRequest.fields.find((field: any) => field.field === "thickness")).toEqual({ field: "thickness", missing: 0, unconfirmed: [{ value: 25, unit: "cm", origin: "entered", count: 1 }] });
    expect(context.data.ceilings).toEqual([{ ceilingId: ceiling[0].id, roomIds: expect.any(Array), upperStoreyId: null }]);
    expect(context.data.entities.find((entity: any) => entity.id === ceiling[0].id)).toMatchObject({ provenance: "inferred", reviewStatus: "unreviewed" });
    const wallGaps = context.data.missingInputs.filter((gap: any) => gap.entityId === kitchenWall).map((gap: any) => `${gap.field}:${gap.status}`);
    expect(wallGaps).toEqual(["construction:unreviewed", "bulkDensity:unreviewed", "wallRole:unreviewed"]);
    expect(context.data.wallAdjacency.some((item: any) => item.exterior && item.roomId === null)).toBe(true);

    // A construction description fills what it states, as unreviewed proposals that never replace entries.
    const description = crypto.randomUUID(), descriptionVersion = crypto.randomUUID();
    await pool.query("insert into projects_files (id,tenant_id,project_id,name,source_type,created_by) values ($1,$2,$3,'Baubeschreibung.pdf','upload',$4)", [description, tenant, project, actor]);
    await pool.query("insert into projects_file_versions (id,tenant_id,file_id,version,status,storage_key,mime_type,created_by) values ($1,$2,$3,1,'ready','test','application/pdf',$4)", [descriptionVersion, tenant, description, actor]);
    await pool.query("insert into projects_source_pages (version_id,tenant_id,page,content) values ($1,$2,4,$3)", [descriptionVersion, tenant,
      JSON.stringify({ status: "available", text: "3.2 Außenwände\nAußenwände Kalksandstein 36,5 cm.\n\n3.3 Wohnungstrennwände\nWohnungstrennwände KS 24 cm, RDK 2,0.\n\n4. Decken\nGeschossdecken aus Stahlbeton, d = 22 cm." })]);
    // Automatic processing registers every PDF's pages; a description has no floor-plan page, so it stays a document.
    await pool.query("insert into projects_building_plan_sources (tenant_id,model_id,storey_id,source_version_id,page,created_by) values ($1,$2,null,$3,4,$4)", [tenant, model, descriptionVersion, actor]);
    const documents = (await (await fetch(base + "/component-sources")).json()).data.documents;
    // The plan itself is a plan source, not a description.
    expect(documents.map((doc: any) => [doc.name, doc.likelyConstructionDescription])).toEqual([["Baubeschreibung.pdf", true]]);
    const partitions = [...(await roles()).entries()].filter(([, r]) => r.value === "apartment_partition").map(([id]) => id);
    const read = await post("/component-sources", { baseRevision: await revision(), sourceVersionId: descriptionVersion });
    expect(read.status).toBe(200);
    // Partition walls already carry entered construction, thickness and density; only the material is new. The ceiling gets all three.
    const exterior = [...(await roles()).entries()].filter(([, r]) => r.value === "exterior").map(([id]) => id);
    expect(read.body.data.summary.groups).toEqual([
      // Exterior walls only had plan-measured thickness proposals; the stated thickness replaces them.
      { componentType: "wall", wallRole: "exterior", values: { material: "Kalksandstein", construction: "masonry", thickness: 36.5 }, conflicts: [], components: exterior.length, proposed: exterior.length * 3 },
      { componentType: "wall", wallRole: "apartment_partition", values: { material: "Kalksandstein", construction: "masonry", thickness: 24, bulkDensity: 2000 }, conflicts: [], components: partitions.length, proposed: partitions.length },
      { componentType: "ceiling", wallRole: null, values: { material: "Stahlbeton", construction: "concrete", thickness: 22 }, conflicts: [], components: 1, proposed: 3 },
    ]);
    const ceilingThickness = (await pool.query(`select v.value, v.provenance, v.evidence from projects_building_properties p join projects_building_property_versions v on v.property_id=p.id where p.entity_id=$1 and p.property_key='thickness'`, [ceiling[0].id])).rows;
    expect(ceilingThickness).toEqual([{ value: 22, provenance: "inferred", evidence: [{ kind: "page", sourceVersionId: descriptionVersion, page: 4, quote: "Geschossdecken aus Stahlbeton, d = 22 cm." }] }]);
    expect((await thickness()).get(corridorWall)).toMatchObject({ value: 25, provenance: "manual" });
    expect((await post("/component-sources", { baseRevision: await revision(), sourceVersionId: descriptionVersion })).body.data.summary.proposals).toBe(0);
    // A stated thickness is not replaced by the plan measurement on the next derivation.
    expect((await post("/wall-adjacency", { baseRevision: await revision() })).body.data.summary.thicknessProposals).toBe(0);
    const stated = await thickness();
    expect(exterior.map(id => [stated.get(id)?.value, stated.get(id)?.provenance])).toEqual(exterior.map(() => [36.5, "inferred"]));
    expect(audits).toContain("projects.building.component.description_read");

    // An inquiry keeps the items as sent; what is answered since is computed from the model, however the answer arrives.
    const inquiry = (path: string, body: unknown, method = "POST") => post(path, body, method, inquiriesBase);
    expect((await inquiry("", { kind: "component_data", title: "Bauteildaten", counterpart: "" })).status).toBeGreaterThanOrEqual(400);
    const sent = await inquiry("", { kind: "component_data", title: "Bauteildaten", counterpart: "Architekturbüro Muster", request: { subject: "Bauteildaten", body: "Bitte ergänzen: Decken …" } });
    expect(sent.status).toBe(201);
    expect(sent.body.data.status).toBe("waiting");
    const ceilingItem = sent.body.data.items.find((group: any) => group.componentType === "ceiling");
    expect(ceilingItem.fields.map((field: any) => field.field)).toEqual(["construction", "thickness", "bulkDensity"]);
    const detail = async () => (await (await fetch(`${inquiriesBase}/${sent.body.data.id}`)).json()).data;
    const initial = (await detail()).progress;
    expect(initial.answered).toBe(0);

    // The architect's reply is filed as an email; quoted earlier text is not read as an answer.
    expect((await inquiry(`/${sent.body.data.id}/entries`, { kind: "note", direction: "incoming", body: "x" })).status).toBe(400);
    const reply = await inquiry(`/${sent.body.data.id}/entries`, { kind: "email", direction: "incoming", subject: "AW: Bauteildaten",
      body: "Hallo,\nWohnungstrenndecken: Stahlbeton, Rohdichte 2,4.\n\nAm 3. März schrieb Richtfest:\n> Außenwände Kalksandstein 30 cm" });
    expect(reply.body.data.status).toBe("answered");
    const readReply = await inquiry(`/${sent.body.data.id}/entries/${reply.body.data.entry.id}/read-components`, { baseRevision: await revision() });
    expect(readReply.status).toBe(200);
    expect(readReply.body.data.summary.groups).toEqual([{ componentType: "ceiling", wallRole: null, values: { material: "Stahlbeton", construction: "concrete", bulkDensity: 2400 }, conflicts: [], components: 1, proposed: 1 }]);
    expect((await latestVersion(ceiling[0].id, "bulkDensity"))).toBeDefined();
    const density = (await pool.query(`select v.evidence from projects_building_properties p join projects_building_property_versions v on v.property_id=p.id where p.entity_id=$1 and p.property_key='bulkDensity'`, [ceiling[0].id])).rows;
    expect(density).toEqual([{ evidence: [{ kind: "correspondence", inquiryId: sent.body.data.id, entryId: reply.body.data.entry.id, quote: "Wohnungstrenndecken: Stahlbeton, Rohdichte 2,4." }] }]);
    // Correspondence evidence is Richtfest's own record; clients cannot attach it.
    expect((await post("/properties", { baseRevision: await revision(), entityType: "element", entityId: ceiling[0].id, propertyKey: "thickness", value: 20, unit: "cm", provenance: "manual",
      evidence: density[0].evidence })).status).toBe(422);
    const outstandingBeforeReview = (await detail()).progress;

    const ceilingState = await latestVersion(ceiling[0].id, "thickness");
    expect((await post("/properties/review", { baseRevision: await revision(), decision: "approved", items: [ceilingState] })).status).toBe(200);
    const afterReview = (await detail()).progress;
    expect(afterReview).toMatchObject({ total: initial.total, answered: outstandingBeforeReview.answered + 1 });
    expect(afterReview.outstanding.find((group: any) => group.componentType === "ceiling").fields.map((field: any) => field.field)).toEqual(["construction", "bulkDensity"]);
    expect((await (await fetch(base + "/agent-context")).json()).data.soundInsulation.inquiries[0]).toMatchObject({ counterpart: "Architekturbüro Muster", status: "answered", progress: { answered: afterReview.answered } });
    expect((await detail()).entries.map((entry: any) => `${entry.kind}:${entry.direction}`)).toEqual(["request:outgoing", "email:incoming"]);
    const closed = await inquiry(`/${sent.body.data.id}`, { status: "closed" }, "PATCH");
    expect(closed.body.data.closedAt).toBeTruthy();
    expect((await (await fetch(base + "/agent-context")).json()).data.soundInsulation.inquiries).toEqual([]);
    expect(audits).toEqual(expect.arrayContaining(["projects.inquiry.created", "projects.inquiry.entry_added", "projects.inquiry.reply_read", "projects.inquiry.updated"]));
  } finally { server.close(); await pool.end(); await admin.pool.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.pool.end(); }
}, 60000);
