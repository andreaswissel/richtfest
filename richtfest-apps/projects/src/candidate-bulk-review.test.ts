import { expect, test } from "bun:test";
import { candidateReviewScore, candidateReviewScoreVersion } from "./candidate-review-score";

const rectangle = (x = .1, y = .1, size = .1) => [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }];
const geometry = () => ({ quality: "enclosed_region", polygon: rectangle(), holes: [],
  topology: { status: "enclosed", competingSourceKeys: [] }, shapeQc: { status: "unreviewed" },
  semanticQc: { status: "unreviewed", duplicateLivingKitchen: false },
  printedScaleQc: { status: "unreviewed", estimatedArea: 10, printedArea: 10, toleranceM2: 1 },
  areaRatioQc: { status: "unreviewed", sampleCount: 5, relativeToMedian: 1 },
  printedArea: { value: 10 }, printedGrossArea: { value: 12 }, roomUseProposal: { confidence: .99, roomUse: "bedroom" } });

test("geometry score is five-check coverage; label confidence cannot supply geometry evidence", () => {
  const score = (g: any) => candidateReviewScore({ entityType: "room", geometry: g });
  expect(score(geometry())).toMatchObject({ score: 100, blocked: false });
  expect(score({ ...geometry(), printedScaleQc: null })).toMatchObject({ score: 80, blocked: false });
  expect(score({ ...geometry(), printedScaleQc: null, areaRatioQc: null })).toMatchObject({ score: 60, blocked: false });
  expect(score({ roomUseProposal: { confidence: 1 }, confidence: 1 }).score).toBeNull();
  expect(candidateReviewScore({ entityType: "element", geometry: geometry() }).score).toBeNull();
  for (const value of [.5, 2]) expect(score({ ...geometry(), areaRatioQc: { status: "unreviewed", sampleCount: 5, relativeToMedian: value } }).score).toBe(100);
  expect(score({ ...geometry(), printedScaleQc: { status: "unreviewed", estimatedArea: 11, printedArea: 10, toleranceM2: 1 } }).score).toBe(100);
  expect(score({ ...geometry(), areaRatioQc: { status: "unreviewed", sampleCount: 4, relativeToMedian: 1 } })).toMatchObject({ score: 80, blocked: false });
  expect(score({ ...geometry(), polygon: rectangle(.1, .1, .5), holes: [rectangle(.2, .2)] }).blocked).toBe(false);
  for (const patch of [
    { quality: "anchor" }, { quality: "approximate_partition" }, { topology: { status: "enclosed", competingSourceKeys: ["other"] } },
    { topology: { status: "enclosed", competingSourceKeys: [], detachedPartCount: 1 } }, { shapeQc: { status: "severe" } },
    { semanticQc: { status: "group_conflict" } }, { capacityQc: { status: "conflict" } }, { sharedAreaQc: { status: "conflict" } },
    { outlineEdit: {} }, { merge: {} }, { openSpace: {} }, { parts: [{}] }, { polygon: [] }, { holes: [rectangle(.7)] },
    { holes: null }, { holes: [null] }, { containsOtherLabel: true },
    { holes: [rectangle(.12, .12, .04), rectangle(.13, .13, .01)] },
    { holes: [rectangle(.12, .12, .04), rectangle(.14, .14, .04)] }, { holes: [rectangle(.1, .12, .04)] },
    { polygon: [{ x: .1, y: .1 }, { x: .3, y: .3 }, { x: .1, y: .3 }, { x: .3, y: .1 }] },
    { polygon: [{ x: .1, y: .1 }, { x: NaN, y: .1 }, { x: .2, y: .2 }] },
    { polygon: [{ x: .1, y: .1 }, { x: Infinity, y: .1 }, { x: .2, y: .2 }] },
    { polygon: rectangle(-.1) }, { polygon: [...rectangle(), rectangle()[0]] },
    { printedScaleQc: { status: "unreviewed", estimatedArea: 11.01, printedArea: 10, toleranceM2: 1 } },
    { areaRatioQc: { status: "unreviewed", sampleCount: 5, relativeToMedian: 2.01 } },
  ]) expect(score({ ...geometry(), ...patch }).blocked).toBe(true);
});

const databaseUrl = process.env.BUILDING_EXTRACTION_TEST_DATABASE_URL;
const localDatabase = databaseUrl && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(databaseUrl).hostname);

(localDatabase ? test : test.skip)("bulk review HTTP: scoped deterministic preview, atomic adoption, no overwrite, replay and audit rollback", async () => {
  const { createRequire } = await import("node:module");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { sql } = await import("drizzle-orm");
  const { default: express } = await import("express");
  const { createBuildingExtractionRouter } = await import("./building-extraction-router");
  const { Pool } = createRequire(import.meta.resolve("drizzle-orm/node-postgres"))("pg");
  const namespace = `candidate_bulk_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${namespace}`);
  const isolated = new URL(databaseUrl!); isolated.searchParams.set("options", `-c search_path=${namespace}`);
  const pool = new Pool({ connectionString: isolated.href }), db = drizzle(pool);
  const tenant = crypto.randomUUID(), otherTenant = crypto.randomUUID(), actor = crypto.randomUUID(), project = crypto.randomUUID(),
    model = crypto.randomUUID(), storey = crypto.randomUUID(), file = crypto.randomUUID(), source = crypto.randomUUID(), otherSource = crypto.randomUUID();
  const app = express(); app.use(express.json());
  app.use(createBuildingExtractionRouter(req => ({ db, tenantId: req.headers["x-other"] ? otherTenant : tenant, actorId: actor,
    requirePermission(key) { expect(key).toBe("projects:write"); if (req.headers["x-denied"]) throw Object.assign(new Error("Forbidden"), { status: 403 }); },
    audit: async (tx, action, _type, _id, receipt) => {
      await tx.execute(sql`insert into bulk_audit (action, receipt) values (${action}, ${JSON.stringify(receipt)}::jsonb)`);
      if (req.headers["x-audit-fail"]) throw new Error("Synthetic audit failure");
    }, validateCustomer: async () => false, customerNames: async () => ({}), fileStorage: {} as any })));
  app.use((e: any, _req: any, res: any, _next: any) => res.status(e.status ?? (e.name === "ZodError" ? 422 : 500)).json({ message: e.message }));
  const server = app.listen(0), base = `http://127.0.0.1:${(server.address() as any).port}/projects/${project}/building-model/extraction-candidates`;
  const scope = { baseRevision: 0, sourceVersionId: source, modelState: "proposed", threshold: 90 };
  const post = async (path: string, body: unknown, headers = {}) => {
    const response = await fetch(`${base}/${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  let page = 0;
  const add = async (patch: any = {}, options: any = {}) => {
    const id = crypto.randomUUID(), job = options.job ?? crypto.randomUUID(), sourceId = options.source ?? source, p = options.page ?? ++page;
    if (!options.job) await pool.query("insert into projects_building_extractions (id,tenant_id,model_id,source_version_id,storey_id,page,extractor_version,status,created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [job, tenant, model, sourceId, storey, p, options.version ?? "test-v1", options.jobStatus ?? "complete", actor]);
    await pool.query("insert into projects_building_extraction_candidates (id,tenant_id,model_id,job_id,source_key,entity_type,name,geometry,evidence) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [id, options.tenant ?? tenant, options.model ?? model, job, options.key ?? id, options.entityType ?? "room", options.name ?? id,
        JSON.stringify({ ...geometry(), ...patch }), JSON.stringify(options.evidence ?? [{ kind: "page", sourceVersionId: sourceId, page: p }])]);
    return { id, job, page: p };
  };
  const revision = async () => (await pool.query("select revision from projects_building_models where id=$1", [model])).rows[0].revision;
  const noWrites = async () => {
    expect(await revision()).toBe(0);
    for (const table of ["projects_building_reconciliations", "projects_building_proposals", "projects_building_reviews", "projects_building_revisions", "bulk_audit"])
      expect((await pool.query(`select count(*)::int n from ${table}`)).rows[0].n).toBe(0);
    expect((await pool.query("select count(*)::int n from projects_building_extraction_candidates where status <> 'unreviewed'")).rows[0].n).toBe(0);
  };
  try {
    for (const table of ["projects_files", "projects_file_versions", "projects_building_models", "projects_building_storeys", "projects_building_rooms", "projects_building_elements",
      "projects_building_extractions", "projects_building_extraction_candidates", "projects_building_superseded_sources", "projects_building_reconciliations",
      "projects_building_proposals", "projects_building_reviews", "projects_building_revisions"])
      await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    await pool.query("create table bulk_audit (action text, receipt jsonb)");
    await pool.query("insert into projects_building_models (id,tenant_id,project_id,created_by) values ($1,$2,$3,$4)", [model, tenant, project, actor]);
    await pool.query("insert into projects_building_storeys (id,tenant_id,model_id,building_id,stable_key,name,created_by) values ($1,$2,$3,$4,'s','Storey',$5)", [storey, tenant, model, crypto.randomUUID(), actor]);
    await pool.query("insert into projects_files (id,tenant_id,project_id,name,source_type,created_by) values ($1,$2,$3,'synthetic.pdf','upload',$4)", [file, tenant, project, actor]);
    for (const [i, id] of [source, otherSource].entries()) await pool.query("insert into projects_file_versions (id,tenant_id,file_id,version,status,storage_key,mime_type,created_by) values ($1,$2,$3,$4,'ready','synthetic','application/pdf',$5)", [id, tenant, file, i + 1, actor]);
    const full = await add(), full2 = await add(), eighty = await add({ printedScaleQc: null }), sixty = await add({ printedScaleQc: null, areaRatioQc: null });
    const unknown = await add({ topology: null }), wall = await add({ constructionState: "proposed" }, { entityType: "element" });
    const demolishedWall = await add({ constructionState: "demolished" }, { entityType: "element" });
    const conflict = await add({ sharedAreaQc: { status: "conflict" } }), badPolygon = await add({ polygon: rectangle(-.1) });
    await add({ holes: [rectangle(.7)] });
    const foreign = await add({}, { tenant: otherTenant }), swapped = await add({}, { source: otherSource });
    await add({}, { jobStatus: "running" }); await add({}, { model: crypto.randomUUID() });
    await add({}, { evidence: [{ kind: "page", sourceVersionId: otherSource, page: 1 }] });
    const adoption = { ...scope, scoreVersion: candidateReviewScoreVersion, candidateIds: [full.id, full2.id] };
    const preview = await post("preview", scope);
    expect(preview.status).toBe(200);
    expect(preview.body.data.eligible.map((c: any) => c.id)).toEqual([full.id, full2.id].sort());
    expect(preview.body.data).toMatchObject({ ...scope, scoreVersion: candidateReviewScoreVersion, unscoredCount: 2, excludedCount: 6 });
    expect((await post("preview", scope)).body).toEqual(preview.body); await noWrites();
    for (const [threshold, count] of [[0, 4], [60, 4], [61, 3], [80, 3], [81, 2], [90, 2], [100, 2]]) {
      const response = await post("preview", { ...scope, threshold }); expect(response.status).toBe(200); expect(response.body.data.eligible).toHaveLength(count);
    }
    for (const modelState of ["existing", "demolition"]) {
      const response = await post("preview", { ...scope, modelState });
      expect(response.body.data.eligible).toEqual(preview.body.data.eligible);
      expect(response.body.data.unscoredCount).toBe(modelState === "existing" ? 1 : 2);
    }
    for (const path of ["preview", "adopt"]) {
      const input = path === "preview" ? scope : adoption;
      expect((await post(path, input, { "x-other": "1" })).status).toBe(404);
      expect((await post(path, input, { "x-denied": "1" })).status).toBe(403);
      expect((await post(path, { ...input, baseRevision: 1 })).body.error.code).toBe("revision_conflict");
      for (const patch of [{ threshold: -1 }, { threshold: 101 }, { threshold: 90.5 }, { modelState: "unknown" }, { sourceVersionId: [source] }, { surprise: true }])
        expect((await post(path, { ...input, ...patch })).status).toBe(422);
    }
    expect((await post("adopt", { ...adoption, scoreVersion: "old" })).body.error.code).toBe("score_version_conflict");
    for (const candidateIds of [[], [full.id, full.id]]) expect((await post("adopt", { ...adoption, candidateIds })).status).toBe(422);
    for (const id of [unknown.id, wall.id, demolishedWall.id, conflict.id, badPolygon.id, eighty.id, sixty.id, foreign.id, swapped.id, crypto.randomUUID()]) {
      expect((await post("adopt", { ...adoption, candidateIds: [full.id, id] })).body.error.code).toBe("candidate_eligibility_changed"); await noWrites();
    }
    expect((await post("adopt", { ...adoption, threshold: 0, candidateIds: [unknown.id] })).status).toBe(409);
    expect((await post("adopt", { ...adoption, sourceVersionId: otherSource })).status).toBe(409);
    for (const [table, column, invalid, valid] of [
      ["projects_files", "project_id", crypto.randomUUID(), project], ["projects_file_versions", "tenant_id", otherTenant, tenant],
      ["projects_file_versions", "status", "pending", "ready"], ["projects_file_versions", "mime_type", "application/x-step", "application/pdf"],
    ]) {
      await pool.query(`update ${table} set ${column}=$1`, [invalid]);
      expect((await post("preview", scope)).status).toBe(422); expect((await post("adopt", adoption)).status).toBe(422);
      await pool.query(`update ${table} set ${column}=$1`, [valid]); await noWrites();
    }
    await pool.query("insert into projects_building_superseded_sources (tenant_id,model_id,source_version_id,created_by) values ($1,$2,$3,$4)", [tenant, model, source, actor]);
    expect((await post("preview", scope)).status).toBe(422); expect((await post("adopt", adoption)).status).toBe(422);
    await pool.query("delete from projects_building_superseded_sources");
    // A refreshed QC record invalidates eligibility even without a revision bump.
    await pool.query("update projects_building_extraction_candidates set geometry=$1 where id=$2", [JSON.stringify({ ...geometry(), shapeQc: { status: "severe" } }), full.id]);
    expect((await post("adopt", adoption)).status).toBe(409); await noWrites();
    await pool.query("update projects_building_extraction_candidates set geometry=$1 where id=$2", [JSON.stringify(geometry()), full.id]);
    // Duplicate source identities across runs and canonical match risks never become new rooms.
    const duplicate = await add({}, { page: full.page, version: "test-v2", key: full.id });
    expect((await post("adopt", adoption)).status).toBe(409); await noWrites();
    await pool.query("delete from projects_building_extraction_candidates where id=$1", [duplicate.id]);
    const existing = crypto.randomUUID();
    await pool.query("insert into projects_building_rooms (id,tenant_id,model_id,storey_id,stable_key,name,geometry,created_by) values ($1,$2,$3,$4,'manual',$5,$6,$7)",
      [existing, tenant, model, storey, full.id, JSON.stringify({ polygon: rectangle(.6), source: { sourceVersionId: source, page: full.page } }), actor]);
    const canonicalBefore = (await pool.query("select * from projects_building_rooms")).rows;
    expect((await post("adopt", adoption)).status).toBe(409);
    expect((await pool.query("select * from projects_building_rooms")).rows).toEqual(canonicalBefore); await noWrites();
    await pool.query("delete from projects_building_rooms");
    await pool.query("insert into projects_building_reconciliations (tenant_id,model_id,source_version_id,source_entity_key,target_entity_type,method,status,created_by) values ($1,$2,$3,$4,'room','manual','rejected',$5)",
      [tenant, model, source, `plan:${storey}:${full.page}:${full.id}`, actor]);
    expect((await post("adopt", adoption)).status).toBe(409);
    expect((await pool.query("select status from projects_building_reconciliations")).rows).toEqual([{ status: "rejected" }]);
    await pool.query("delete from projects_building_reconciliations");
    expect((await post("adopt", adoption, { "x-audit-fail": "1" })).status).toBe(500); await noWrites();
    expect((await pool.query("select count(*)::int n from projects_building_rooms")).rows[0].n).toBe(0);
    const attempts = await Promise.all([post("adopt", adoption), post("adopt", adoption)]);
    expect(attempts.map(r => r.status).sort()).toEqual([200, 409]);
    expect(attempts.find(r => r.status === 200)!.body.data).toEqual({ revision: 1, adoptedCount: 2, candidateIds: [full.id, full2.id].sort() });
    expect((await post("adopt", adoption)).body.error.code).toBe("revision_conflict");
    expect((await post("adopt", { ...adoption, baseRevision: 1 })).body.error.code).toBe("candidate_eligibility_changed");
    expect(await revision()).toBe(1);
    expect((await pool.query("select status from projects_building_revisions")).rows).toEqual([{ status: "draft" }]);
    const savedRooms = (await pool.query("select geometry,room_use,construction_state from projects_building_rooms")).rows;
    expect(savedRooms).toHaveLength(2);
    for (const room of savedRooms) {
      expect(room.construction_state).toBe("unknown"); expect(room.room_use).toBeNull();
      for (const key of ["printedArea", "printedGrossArea", "areaRatioQc", "roomUseProposal"]) expect(room.geometry[key]).toBeUndefined();
    }
    const audit = (await pool.query("select receipt from bulk_audit")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].receipt).toMatchObject({ ...scope, scoreVersion: candidateReviewScoreVersion, reviewScope: "identity_outline_only", modelRevision: 1 });
    expect(audit[0].receipt.candidates).toEqual(preview.body.data.eligible);
    const batchProposals = (await pool.query("select payload from projects_building_proposals order by payload->>'candidateId'")).rows;
    expect(batchProposals).toHaveLength(2);
    for (const { payload } of batchProposals) expect(payload).toMatchObject({ note: null, outcome: "accepted_unchanged",
      reviewSnapshot: { sourceVersionId: source, storeyId: storey, extractorVersion: "test-v1", geometry: geometry(),
        scoreCoverage: 100, scoreVersion: candidateReviewScoreVersion, scoreBlocked: false, scoreChecks: candidateReviewScore({ entityType: "room", geometry: geometry() }).checks } });
    // A low-score room may be individually reviewed, without blanket engineering approval.
    const single = await post(`${eighty.id}/review`, { baseRevision: 1, decision: "approved", name: "Individually reviewed" });
    expect(single.status).toBe(200); expect(single.body.data.revision).toBe(2); expect(single.body.data.entity.name).toBe("Individually reviewed");
    expect((await pool.query("select status from projects_building_revisions where revision=2")).rows).toEqual([{ status: "draft" }]);
    expect((await pool.query("select payload from projects_building_proposals where payload->>'candidateId'=$1", [eighty.id])).rows[0].payload)
      .toMatchObject({ name: "Individually reviewed", outcome: "accepted_corrected", reviewSnapshot: { name: eighty.id, scoreCoverage: 80 } });
    // Overflow is an explicit error, never a silently truncated selection.
    const batch = await add({}, { page: 1000 });
    await pool.query("delete from projects_building_extraction_candidates where id=$1", [batch.id]);
    await pool.query(`insert into projects_building_extraction_candidates (tenant_id,model_id,job_id,source_key,entity_type,name,geometry,evidence)
      select $1,$2,$3,'overflow:'||n,'room','Overflow '||n,$4::jsonb,$5::jsonb from generate_series(1,1001) n`,
      [tenant, model, batch.job, JSON.stringify(geometry()), JSON.stringify([{ kind: "page", sourceVersionId: source, page: 1000 }])]);
    expect((await post("preview", { ...scope, baseRevision: 2 })).body.error.code).toBe("candidate_scope_overflow");
    expect((await post("adopt", { ...adoption, baseRevision: 2 })).body.error.code).toBe("candidate_scope_overflow");
    expect(await revision()).toBe(2);
    await pool.query("delete from projects_building_extraction_candidates where job_id=$1", [batch.job]);
    // Unscored fragments do not consume the room limit or enter the adoption.
    await pool.query(`insert into projects_building_extraction_candidates (tenant_id,model_id,job_id,source_key,entity_type,name,geometry,evidence)
      select $1,$2,$3,'fragment:'||n,'element','Fragment '||n,'{}'::jsonb,'[]'::jsonb from generate_series(1,1100) n`,
      [tenant, model, batch.job]);
    // Hundreds of independent outlines are returned and adopted, not just a page-sized subset.
    const many: string[] = [];
    for (let n = 0; n < 240; n++) many.push((await add({ polygon: rectangle(.01 + n % 20 * .04, .01 + Math.floor(n / 20) * .04, .02) }, { job: batch.job, page: 1000 })).id);
    const manyPreview = await post("preview", { ...scope, baseRevision: 2 });
    expect(manyPreview.status).toBe(200); expect(manyPreview.body.data.eligible.map((item: any) => item.id)).toEqual(many.sort());
    expect(manyPreview.body.data.unscoredCount).toBeGreaterThanOrEqual(1100);
    const manyResult = await post("adopt", { ...scope, baseRevision: 2, scoreVersion: candidateReviewScoreVersion, candidateIds: many });
    expect(manyResult.status).toBe(200); expect(manyResult.body.data).toEqual({ revision: 3, adoptedCount: 240, candidateIds: many });
    expect((await pool.query("select count(*)::int n from projects_building_rooms")).rows[0].n).toBe(243);
    expect((await pool.query("select status from projects_building_revisions where revision=3")).rows).toEqual([{ status: "draft" }]);
    const target = single.body.data.entity.id;
    const targetBefore = (await pool.query("select * from projects_building_rooms where id=$1", [target])).rows;
    expect((await post(`${sixty.id}/review`, { baseRevision: 3, decision: "approved", targetEntityId: target })).status).toBe(200);
    expect((await pool.query("select * from projects_building_rooms where id=$1", [target])).rows).toEqual(targetBefore);
    expect((await pool.query("select count(*)::int n from projects_building_rooms")).rows[0].n).toBe(243);
    expect((await post(`${unknown.id}/review`, { baseRevision: 4, decision: "rejected" })).status).toBe(200);
    expect((await pool.query("select status from projects_building_revisions where revision=5")).rows).toEqual([{ status: "draft" }]);

    // Generic room decisions: persist the unresolved issue without changing the candidate.
    const pending = await add(), pendingReject = await add();
    const decisions = ["approved", "rejected", "deferred"];
    const review = async (id: string, decision: string, extra: any = {}, headers = {}) =>
      post(`${id}/review`, { baseRevision: await revision(), decision, ...(decision === "deferred" ? { note: "Verify boundary against source" } : {}), ...extra }, headers);
    const history = async (id: string) => (await pool.query("select * from projects_building_proposals where payload->>'candidateId'=$1 order by expected_revision desc", [id])).rows;
    const state = async () => {
      const result: any = {};
      for (const table of ["projects_building_models", "projects_building_extraction_candidates", "projects_building_rooms", "projects_building_elements",
        "projects_building_reconciliations", "projects_building_proposals", "projects_building_reviews", "projects_building_revisions"])
        result[table] = (await pool.query(`select * from ${table} order by id`)).rows;
      result.audit = (await pool.query("select * from bulk_audit order by receipt->>'modelRevision'")).rows;
      return result;
    };
    const unchanged = async (act: () => Promise<any>, status: number, code?: string) => {
      const before = await state(), response = await act();
      expect(response.status).toBe(status);
      if (code) expect(response.body.error.code).toBe(code);
      expect(await state()).toEqual(before);
    };
    for (const note of [undefined, "", "  ", null, "x".repeat(4001)])
      await unchanged(() => review(pending.id, "deferred", { note }), 422);
    for (const extra of [{ outcome: "accepted_unchanged" }, { reviewSnapshot: {} }])
      await unchanged(() => review(pending.id, "approved", extra), 422);
    for (const decision of decisions) {
      await unchanged(() => review(pending.id, decision, {}, { "x-denied": "1" }), 403);
      await unchanged(() => review(pending.id, decision, {}, { "x-other": "1" }), 404);
      await unchanged(() => review(foreign.id, decision), 404);
      await unchanged(() => review(pending.id, decision, { baseRevision: 0 }), 409, "revision_conflict");
    }
    // Reject/defer cannot bypass source, job, model, storey or tenant checks either.
    for (const [table, column, invalid, valid, id, code] of [
      ["projects_files", "project_id", crypto.randomUUID(), project, file, "invalid_source_revision"],
      ["projects_files", "tenant_id", otherTenant, tenant, file, "invalid_source_revision"],
      ["projects_file_versions", "tenant_id", otherTenant, tenant, source, "invalid_source_revision"],
      ["projects_file_versions", "status", "pending", "ready", source, "invalid_source_revision"],
      ["projects_building_extractions", "tenant_id", otherTenant, tenant, pending.job, "invalid_candidate"],
      ["projects_building_extractions", "model_id", crypto.randomUUID(), model, pending.job, "invalid_candidate"],
      ["projects_building_storeys", "model_id", crypto.randomUUID(), model, storey, "invalid_storey"],
    ]) {
      await pool.query(`update ${table} set ${column}=$1 where id=$2`, [invalid, id]);
      for (const decision of decisions) await unchanged(() => review(pending.id, decision), 422, code);
      await pool.query(`update ${table} set ${column}=$1 where id=$2`, [valid, id]);
    }
    for (const status of ["queued", "running", "failed"]) {
      await pool.query("update projects_building_extractions set status=$1 where id=$2", [status, pending.job]);
      for (const decision of decisions) await unchanged(() => review(pending.id, decision), 409, "extraction_incomplete");
    }
    await pool.query("update projects_building_extractions set status='complete' where id=$1", [pending.job]);
    await pool.query("insert into projects_building_superseded_sources (tenant_id,model_id,source_version_id,created_by) values ($1,$2,$3,$4)", [tenant, model, source, actor]);
    for (const decision of decisions) await unchanged(() => review(pending.id, decision), 422, "invalid_source_revision");
    await pool.query("delete from projects_building_superseded_sources");
    const wrongEvidence = await add({}, { evidence: [{ kind: "page", sourceVersionId: otherSource, page: 1 }] });
    for (const decision of decisions) await unchanged(() => review(wrongEvidence.id, decision), 422, "invalid_candidate_source");
    for (const decision of decisions)
      await unchanged(() => review(pending.id, decision, {}, { "x-audit-fail": "1" }), 500);
    // Simulate a worker holding a completed job before requeue. Reviews fail
    // closed rather than deadlock against its job -> model lock order.
    const worker = await pool.connect();
    try {
      await worker.query("begin");
      await worker.query("select id from projects_building_extractions where id=$1 for update", [pending.job]);
      for (const decision of decisions) await unchanged(() => review(pending.id, decision), 409, "extraction_incomplete");
      await unchanged(async () => post("adopt", { ...scope, baseRevision: await revision(), scoreVersion: candidateReviewScoreVersion,
        candidateIds: [pending.id, pendingReject.id] }), 409, "extraction_incomplete");
    } finally { await worker.query("rollback"); worker.release(); }
    const candidateBefore = (await pool.query("select * from projects_building_extraction_candidates where id=$1", [pending.id])).rows;
    const canonicalBeforeDefer = (await pool.query("select * from projects_building_rooms order by id")).rows;
    const reconciliationsBeforeDefer = (await pool.query("select * from projects_building_reconciliations order by id")).rows;
    const deferredBase = await revision();
    const deferred = await review(pending.id, "deferred", { note: "  Boundary requires source check  " });
    expect(deferred.status).toBe(200);
    expect(deferred.body.data).toMatchObject({ entity: null, revision: deferredBase + 1, candidate: { status: "unreviewed", reviewedAt: null, reviewedBy: null } });
    expect((await pool.query("select * from projects_building_extraction_candidates where id=$1", [pending.id])).rows).toEqual(candidateBefore);
    expect((await pool.query("select * from projects_building_rooms order by id")).rows).toEqual(canonicalBeforeDefer);
    expect((await pool.query("select * from projects_building_reconciliations order by id")).rows).toEqual(reconciliationsBeforeDefer);
    const deferredHistory = await history(pending.id);
    expect(deferredHistory).toHaveLength(1);
    expect(deferredHistory[0]).toMatchObject({ proposal_type: "plan_room_candidate", status: "deferred", created_by: actor, expected_revision: deferredBase,
      payload: { candidateId: pending.id, name: pending.id, note: "Boundary requires source check", outcome: "deferred", geometryQuality: "enclosed_region",
        reviewSnapshot: { jobId: pending.job, sourceVersionId: source, page: pending.page, storeyId: storey, sourceKey: pending.id,
          extractorVersion: "test-v1", geometry: geometry(), name: pending.id, scoreCoverage: 100, scoreVersion: candidateReviewScoreVersion } } });
    expect((await pool.query("select decision,note from projects_building_reviews where proposal_id=$1", [deferredHistory[0].id])).rows)
      .toEqual([{ decision: "deferred", note: "Boundary requires source check" }]);
    await unchanged(() => review(pending.id, "deferred", { baseRevision: deferredBase }), 409, "revision_conflict");
    const deferredPreview = await post("preview", { ...scope, baseRevision: await revision() });
    expect(deferredPreview.status).toBe(200);
    expect(deferredPreview.body.data.eligible.some((c: any) => c.id === pending.id)).toBe(false);
    expect(deferredPreview.body.data.eligible.some((c: any) => c.id === pendingReject.id)).toBe(true);
    await unchanged(async () => post("adopt", { ...scope, baseRevision: await revision(), scoreVersion: candidateReviewScoreVersion, candidateIds: [pending.id, pendingReject.id] }), 409, "candidate_eligibility_changed");
    expect((await review(pending.id, "approved", { note: "Source checked" })).status).toBe(200);
    expect((await history(pending.id))[0].payload).toMatchObject({ outcome: "accepted_unchanged", note: "Source checked" });
    expect((await history(pending.id))[1]).toEqual(deferredHistory[0]);
    for (const decision of decisions) await unchanged(() => review(pending.id, decision), 409, "already_reviewed");
    expect((await review(pendingReject.id, "deferred")).status).toBe(200);
    expect((await review(pendingReject.id, "rejected", { note: "Duplicate source label" })).status).toBe(200);
    expect((await history(pendingReject.id)).map((p: any) => p.payload.outcome)).toEqual(["rejected", "deferred"]);
    // A stored outline correction counts as corrected even without a rename; its
    // exact review snapshot stays unchanged when mutable source observations change.
    const correctedGeometry = { ...geometry(), quality: "manual_outline", outlineEdit: { method: "draw", editCount: 1 } };
    const corrected = await add(correctedGeometry);
    expect((await review(corrected.id, "approved")).status).toBe(200);
    const correctedHistory = await history(corrected.id);
    expect(correctedHistory[0].payload).toMatchObject({ outcome: "accepted_corrected", reviewSnapshot: { geometry: correctedGeometry } });
    await pool.query("update projects_building_extraction_candidates set name='Later observation',geometry='{}' where id=$1", [corrected.id]);
    await pool.query("update projects_building_extractions set extractor_version='test-v2' where id=$1", [corrected.job]);
    expect(await history(corrected.id)).toEqual(correctedHistory);
    // Anchors are reviewable issues, not confirmed geometry; reconcile is explicit
    // and never overwrites the target. Elements retain their legacy approval path.
    const anchor = await add({ quality: "anchor", polygon: null });
    await unchanged(() => review(anchor.id, "approved"), 422, "room_outline_required");
    await unchanged(() => review(anchor.id, "approved", { targetEntityId: crypto.randomUUID() }), 422, "invalid_target");
    expect((await review(anchor.id, "deferred")).status).toBe(200);
    expect((await review(anchor.id, "approved", { targetEntityId: target })).status).toBe(200);
    expect((await history(anchor.id))[0].payload.outcome).toBe("reconciled");
    expect((await pool.query("select * from projects_building_rooms where id=$1", [target])).rows).toEqual(targetBefore);
    for (const polygon of [[], rectangle(-.1), [{ x: .1, y: .1 }, { x: .2, y: .2 }, { x: .3, y: .3 }], [{ x: null, y: .1 }, ...rectangle()]]) {
      const unusable = await add({ polygon });
      await unchanged(() => review(unusable.id, "approved"), 422, "room_outline_required");
    }
    expect((await review(wall.id, "approved")).status).toBe(200);
    expect((await pool.query("select status from projects_building_revisions where revision=$1", [await revision()])).rows).toEqual([{ status: "approved" }]);
  } finally {
    server.close(); await pool.end(); await admin.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.end();
  }
}, 60000);
