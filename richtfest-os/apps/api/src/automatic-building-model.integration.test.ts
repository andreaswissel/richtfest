import { expect, test } from "bun:test";
import express from "express";
import { ensureAutomaticPlanExtractions } from "@richtfest/projects/automatic-building-model";
import { createBuildingModelRouter } from "@richtfest/projects/building-model";
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
      [version, tenant, JSON.stringify({ imageClassification: { totalPages: 12, attemptedPages: 12, completedPages: 12, receipts } })]);
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
    expect(await ensureAutomaticPlanExtractions(deps, new AbortController().signal)).toBe(false);
    expect((await pool.query("select count(*)::int n from projects_building_extractions")).rows[0].n).toBe(5);
    await pool.query("update projects_building_extractions set status='complete'");
    await pool.query("update projects_source_models set metadata=jsonb_set(jsonb_set(metadata,'{automaticBuildingModel,status}','\"partial\"'),'{automaticBuildingModel,unresolvedPages}','[12]')");
    const app = express(); app.use(express.json());
    app.use(createBuildingModelRouter(() => ({ db, tenantId: tenant, actorId: actor, requirePermission: () => {},
      audit: async () => {}, validateCustomer: async () => false, customerNames: async () => ({}), fileStorage: {} as any })));
    const server = app.listen(0);
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/projects/${project}/building-model`).then(result => result.json());
    expect(response.data.automaticPlanProcessing[0]).toMatchObject({ status: "partial", currentPhase: "partial", unresolvedPages: [12] });
    server.close();
  } finally {
    await pool.end(); await admin.pool.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.pool.end();
  }
}, 30_000);
