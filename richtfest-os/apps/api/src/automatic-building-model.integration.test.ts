import { expect, test } from "bun:test";
import express from "express";
import { ensureAutomaticPlanExtractions } from "@richtfest/projects/automatic-building-model";
import { createBuildingModelRouter } from "@richtfest/projects/building-model";
import { runBuildingExtraction } from "@richtfest/projects/building-extraction";
import { SOURCE_IMAGE_MODEL, SOURCE_IMAGE_QUERY_VERSION } from "@richtfest/shared";
import { createDatabase } from "./db/client";

const url = process.env.BUILDING_EXTRACTION_TEST_DATABASE_URL;
const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);

(local ? test : test.skip)("terminal PDF processing still creates one draft model when generative document parsing is unconfigured", async () => {
  const namespace = `automatic_building_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(url!); await admin.pool.query(`CREATE SCHEMA ${namespace}`);
  const isolated = new URL(url!); isolated.searchParams.set("options", `-c search_path=${namespace}`);
  const { db, pool } = createDatabase(isolated.href);
  const tenant = crypto.randomUUID(), project = crypto.randomUUID(), actor = crypto.randomUUID();
  const file = crypto.randomUUID(), version = crypto.randomUUID();
  try {
    const buildingTables = (await admin.pool.query("select tablename from pg_tables where schemaname='public' and tablename like 'projects_building_%' order by tablename")).rows.map(row => row.tablename);
    for (const table of ["projects_projects", "projects_files", "projects_file_versions", "projects_source_extractions",
      "projects_source_pages", "projects_source_models", ...buildingTables]) {
      if (!/^projects_[a-z_]+$/.test(table)) throw new Error("Unexpected test table");
      await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await pool.query("insert into projects_projects (id,tenant_id,name,created_by) values ($1,$2,'Automatic plan',$3)", [project, tenant, actor]);
    await pool.query("insert into projects_files (id,tenant_id,project_id,name,source_type,purpose,created_by) values ($1,$2,$3,'plans.pdf','upload','project_evidence',$4)", [file, tenant, project, actor]);
    await pool.query("insert into projects_file_versions (id,tenant_id,file_id,version,status,storage_key,mime_type,created_by) values ($1,$2,$3,1,'ready','test','application/pdf',$4)", [version, tenant, file, actor]);
    await pool.query("insert into projects_source_extractions (version_id,tenant_id,status,result) values ($1,$2,'complete',$3)", [version, tenant, JSON.stringify({ pages: 12 })]);
    const receipts = Array.from({ length: 12 }, (_, index) => {
      const page = index + 1, floor = page <= 5;
      const inferredFloor = floor || page === 9; // page 9 deliberately exercises source-title precedence.
      return { versionId: version, page, status: "completed", provenance: "inferred", semanticInspection: false,
        queryVersion: SOURCE_IMAGE_QUERY_VERSION, model: SOURCE_IMAGE_MODEL, reason: "bounded triage",
        answers: { page_type: { type: "choice", choice: inferredFloor ? "floor_plan" : "other", confidence: 0.95,
          probabilities: { floor_plan: inferredFloor ? 0.95 : 0.05, other: inferredFloor ? 0.05 : 0.95 } } } };
    });
    await pool.query("insert into projects_source_models (version_id,tenant_id,status,method,metadata) values ($1,$2,'unconfigured','document',$3)",
      [version, tenant, JSON.stringify({ automaticBuildingModel: { status: "pending", enrolledAt: new Date().toISOString(), provenance: "inferred", reviewStatus: "unreviewed" },
        imageClassification: { totalPages: 12, attemptedPages: 12, completedPages: 12, receipts } })]);
    for (let page = 1; page <= 12; page++) {
      const text = page <= 5 ? `${page === 1 ? "Schnittmarke " : ""}Genehmigungsplanung ${"x".repeat(9_000)} Grundriss Seite ${page}` : page === 6 || page === 12 ? "Schnitt A-A" : page <= 8 ? "Ansicht" : page === 9 ? "FREIFLÄCHENPLAN zeichnerischer Nachweis" : "Weitere Planunterlage";
      await pool.query("insert into projects_source_pages (version_id,tenant_id,page,content) values ($1,$2,$3,$4)",
        [version, tenant, page, JSON.stringify({ text, status: "available", reason: "test" })]);
    }
    const deps = { db, fileStorage: { read: async () => null }, audit: async () => {}, reportError: () => {} };
    expect(await ensureAutomaticPlanExtractions(deps, new AbortController().signal)).toBe(true);
    expect((await pool.query("select count(*)::int n from projects_building_models")).rows[0].n).toBe(1);
    expect((await pool.query("select count(*)::int n from projects_building_buildings")).rows[0].n).toBe(1);
    expect((await pool.query("select count(*)::int n from projects_building_storeys")).rows[0].n).toBe(5);
    expect((await pool.query("select count(*)::int n from projects_building_plan_sources")).rows[0].n).toBe(12);
    expect((await pool.query("select count(*)::int n from projects_building_extractions")).rows[0].n).toBe(5);
    const receipt = (await pool.query("select metadata->'automaticBuildingModel' receipt from projects_source_models")).rows[0].receipt;
    expect(receipt).toMatchObject({ status: "planned", pageCount: 12, registeredPageCount: 12,
      floorPlanPages: [1, 2, 3, 4, 5], unresolvedPages: [] });
    expect(receipt.nonFloorPlanPages).toHaveLength(7);
    // Sources without an upload-time enrollment receipt are never claimed (no backfill).
    const legacyFile = crypto.randomUUID(), legacyVersion = crypto.randomUUID(), stuckFile = crypto.randomUUID(), stuckVersion = crypto.randomUUID();
    for (const [fileId, versionId, name] of [[legacyFile, legacyVersion, "legacy.pdf"], [stuckFile, stuckVersion, "stuck.pdf"]]) {
      await pool.query("insert into projects_files (id,tenant_id,project_id,name,source_type,purpose,created_by) values ($1,$2,$3,$4,'upload','project_evidence',$5)", [fileId, tenant, project, name, actor]);
      await pool.query("insert into projects_file_versions (id,tenant_id,file_id,version,status,storage_key,mime_type,created_by) values ($1,$2,$3,1,'ready','test','application/pdf',$4)", [versionId, tenant, fileId, actor]);
      await pool.query("insert into projects_source_extractions (version_id,tenant_id,status,result) values ($1,$2,'complete',$3)", [versionId, tenant, JSON.stringify({ pages: 1 })]);
    }
    await pool.query("insert into projects_source_models (version_id,tenant_id,status,method,metadata) values ($1,$2,'unconfigured','document','{}')", [legacyVersion, tenant]);
    expect(await ensureAutomaticPlanExtractions(deps, new AbortController().signal)).toBe(false);
    // A planner that keeps failing becomes terminal after three claims instead of being reclaimed forever.
    await pool.query("insert into projects_source_models (version_id,tenant_id,status,method,metadata) values ($1,$2,'unconfigured','document',$3)", [stuckVersion, tenant,
      JSON.stringify({ automaticBuildingModel: { status: "processing", attempts: 3, claimedAt: "2000-01-01T00:00:00Z" } })]);
    expect(await ensureAutomaticPlanExtractions(deps, new AbortController().signal)).toBe(true);
    expect((await pool.query("select metadata->'automaticBuildingModel' receipt from projects_source_models where version_id=$1", [stuckVersion])).rows[0].receipt)
      .toMatchObject({ status: "failed", attempts: 3 });
    expect(await ensureAutomaticPlanExtractions(deps, new AbortController().signal)).toBe(false);
    expect((await pool.query("select count(*)::int n from projects_building_extractions")).rows[0].n).toBe(5);
    await pool.query("update projects_building_extractions set status='complete'");
    await pool.query("update projects_source_models set metadata=jsonb_set(jsonb_set(metadata,'{automaticBuildingModel,status}','\"partial\"'),'{automaticBuildingModel,unresolvedPages}','[12]') where version_id=$1", [version]);
    const app = express(); app.use(express.json());
    app.use(createBuildingModelRouter(() => ({ db, tenantId: tenant, actorId: actor, requirePermission: () => {},
      audit: async () => {}, validateCustomer: async () => false, customerNames: async () => ({}), fileStorage: {} as any })));
    const server = app.listen(0);
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/projects/${project}/building-model`).then(result => result.json());
    const processing = response.data.automaticPlanProcessing;
    expect(processing).toHaveLength(2);
    expect(processing.find((item: any) => item.sourceVersionId === version)).toMatchObject({ status: "partial", currentPhase: "partial", unresolvedPages: [12] });
    expect(processing.find((item: any) => item.sourceVersionId === stuckVersion)).toMatchObject({ status: "failed", currentPhase: "failed" });
    // A superseded plan set leaves the model view and the worker queue; restoring it brings everything back.
    const base = `http://127.0.0.1:${(server.address() as any).port}/projects/${project}/building-model`;
    const call = (method: string, body: unknown) => fetch(`${base}/superseded-sources/${version}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await call("PUT", { baseRevision: response.data.model.revision, supersededByVersionId: stuckVersion })).status).toBe(200);
    const superseded = await fetch(base).then(result => result.json());
    expect(superseded.data.storeys).toHaveLength(0);
    expect(superseded.data.extractions).toHaveLength(0);
    expect(superseded.data.planSources.some((source: any) => source.sourceVersionId === version)).toBe(false);
    expect(superseded.data.automaticPlanProcessing.map((item: any) => item.sourceVersionId)).toEqual([stuckVersion]);
    expect(superseded.data.supersededSources).toMatchObject([{ sourceVersionId: version, fileName: "plans.pdf", supersededByVersionId: stuckVersion }]);
    await pool.query("update projects_building_extractions set status='queued'");
    expect(await runBuildingExtraction(deps as any, new AbortController().signal, { plan: false })).toBe(false);
    expect((await call("DELETE", { baseRevision: superseded.data.model.revision })).status).toBe(200);
    expect((await call("DELETE", { baseRevision: superseded.data.model.revision + 1 })).status).toBe(404);
    const restored = await fetch(base).then(result => result.json());
    expect(restored.data.storeys).toHaveLength(5);
    expect(restored.data.supersededSources).toHaveLength(0);
    server.close();
  } finally {
    await pool.end(); await admin.pool.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.pool.end();
  }
}, 30_000);

(local ? test : test.skip)("idle workers upgrade finished older-extractor jobs in place, never legacy duplicates or running jobs", async () => {
  const { upgradeOutdatedExtraction, buildingExtractorVersion } = await import("@richtfest/projects/building-extraction");
  const namespace = `extraction_upgrade_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(url!); await admin.pool.query(`CREATE SCHEMA ${namespace}`);
  const isolated = new URL(url!); isolated.searchParams.set("options", `-c search_path=${namespace}`);
  const { db, pool } = createDatabase(isolated.href);
  try {
    await pool.query("CREATE TABLE projects_building_extractions (LIKE public.projects_building_extractions INCLUDING ALL)"); await pool.query("CREATE TABLE projects_building_superseded_sources (LIKE public.projects_building_superseded_sources INCLUDING ALL)");
    const tenant = crypto.randomUUID(), model = crypto.randomUUID(), storey = crypto.randomUUID(), actor = crypto.randomUUID();
    const job = async (version: string, page: number, extractorVersion: string, status: string) => (await pool.query(
      "insert into projects_building_extractions (tenant_id,model_id,source_version_id,storey_id,page,extractor_version,status,created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
      [tenant, model, version, storey, page, extractorVersion, status, actor])).rows[0].id as string;
    const source = crypto.randomUUID();
    const outdated = await job(source, 1, "topology-v5", "complete");
    const legacyDuplicate = await job(source, 2, "topology-v4", "complete");
    await job(source, 2, buildingExtractorVersion, "complete");
    const running = await job(source, 3, "topology-v5", "running");
    const audits: string[] = [];
    const d = { db, audit: async (_tx: unknown, _tenant: string, action: string) => { audits.push(action); } } as any;
    expect(await upgradeOutdatedExtraction(d)).toBe(true);
    expect(await upgradeOutdatedExtraction(d)).toBe(false);
    const rows = new Map((await pool.query("select id, extractor_version, status, attempts from projects_building_extractions")).rows.map(row => [row.id, row]));
    expect(rows.get(outdated)).toMatchObject({ extractor_version: buildingExtractorVersion, status: "queued", attempts: 0 });
    expect(rows.get(legacyDuplicate)).toMatchObject({ extractor_version: "topology-v4", status: "complete" });
    expect(rows.get(running)).toMatchObject({ extractor_version: "topology-v5", status: "running" });
    expect(audits).toEqual(["projects.building.extraction.upgraded"]);
  } finally {
    await pool.end(); await admin.pool.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.pool.end();
  }
});
