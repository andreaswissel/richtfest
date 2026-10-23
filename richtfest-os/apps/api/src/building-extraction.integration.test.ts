import { expect, test } from "bun:test";
import express from "express";
import { createReadStream } from "node:fs";
import { createBuildingModelRouter } from "@richtfest/projects/building-model";
import { runBuildingExtraction, runPlanHeightExtraction } from "@richtfest/projects/building-extraction";
import { ensureAutomaticExtractionJob } from "@richtfest/projects/automatic-building-model";
import { buildingExtractionJobs } from "@richtfest/projects/schema";
import { createDatabase } from "./db/client";

const url=process.env.BUILDING_EXTRACTION_TEST_DATABASE_URL;
const fixture=process.env.BUILDING_EXTRACTION_TEST_PDF;
const local=url && ["localhost","127.0.0.1","[::1]"].includes(new URL(url).hostname);
(local && fixture ? test : test.skip)("plan extraction persists actual PDF candidates, fences concurrent review and preserves corrections",async()=>{
  const namespace=`building_extraction_test_${crypto.randomUUID().replaceAll("-","")}`;
  const admin=createDatabase(url!);await admin.pool.query(`CREATE SCHEMA ${namespace}`);
  const isolated=new URL(url!);isolated.searchParams.set("options",`-c search_path=${namespace}`);
  const {db,pool}=createDatabase(isolated.href);
  const tenant=crypto.randomUUID(),other=crypto.randomUUID(),project=crypto.randomUUID(),actor=crypto.randomUUID(),model=crypto.randomUUID(),building=crypto.randomUUID(),storey=crypto.randomUUID(),file=crypto.randomUUID(),version=crypto.randomUUID();
  const app=express();app.use(express.json());let audits=0;
  app.use(createBuildingModelRouter(req=>({db,tenantId:req.headers["x-other"]?other:tenant,actorId:actor,
    requirePermission(){if(req.headers["x-denied"])throw Object.assign(new Error("Forbidden"),{status:403});},
    audit:async()=>{audits++;},validateCustomer:async()=>false,customerNames:async()=>({}),fileStorage:{} as any})));
  app.use((e:any,_req:any,res:any,_next:any)=>res.status(e.status??500).json({message:e.message}));
  const server=app.listen(0);const base=`http://127.0.0.1:${(server.address() as any).port}/projects/${project}/building-model`;
  const post=async(path:string,body:unknown,headers:Record<string,string>={})=>{const r=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  try {
    // Clone definitions into a disposable namespace; existing local fixtures are untouched.
    for(const table of ["projects_projects","projects_files","projects_file_versions","projects_source_extractions","projects_source_models",...(await admin.pool.query("select tablename from pg_tables where schemaname='public' and tablename like 'projects_building_%'")).rows.map(r=>r.tablename)]) {
      if(!/^projects_[a-z_]+$/.test(table))throw new Error("Unexpected test table");
      await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await pool.query("insert into projects_projects (id,tenant_id,name,created_by) values ($1,$2,'Extraction test',$3)",[project,tenant,actor]);
    await pool.query("insert into projects_building_models (id,tenant_id,project_id,created_by) values ($1,$2,$3,$4)",[model,tenant,project,actor]);
    await pool.query("insert into projects_building_buildings (id,tenant_id,model_id,stable_key,name,created_by) values ($1,$2,$3,'test','Test',$4)",[building,tenant,model,actor]);
    await pool.query("insert into projects_building_storeys (id,tenant_id,model_id,building_id,stable_key,name,created_by) values ($1,$2,$3,$4,'test','Test',$5)",[storey,tenant,model,building,actor]);
    await pool.query("insert into projects_files (id,tenant_id,project_id,name,source_type,created_by) values ($1,$2,$3,'plan.pdf','upload',$4)",[file,tenant,project,actor]);
    await pool.query("insert into projects_file_versions (id,tenant_id,file_id,version,status,storage_key,mime_type,created_by) values ($1,$2,$3,1,'ready','test','application/pdf',$4)",[version,tenant,file,actor]);
    const [legacyJob]=await db.insert(buildingExtractionJobs).values({tenantId:tenant,modelId:model,
      sourceVersionId:version,storeyId:storey,page:3,extractorVersion:"topology-v3",status:"complete",createdBy:actor}).returning();
    const upgradedJob=await db.transaction((tx:any)=>ensureAutomaticExtractionJob(tx,{tenantId:tenant,modelId:model,
      sourceVersionId:version,storeyId:storey,page:3,createdBy:actor}));
    expect(upgradedJob.id).toBe(legacyJob.id);expect(upgradedJob).toMatchObject({extractorVersion:"topology-v9",status:"queued"});
    expect((await pool.query("select count(*)::int as n from projects_building_extractions")).rows[0].n).toBe(1);
    const input={baseRevision:0,sourceVersionId:version,page:3,storeyId:storey};
    expect((await post("/extractions",input,{"x-other":"1"})).status).toBe(404);
    expect((await post("/extractions",input,{"x-denied":"1"})).status).toBe(403);
    const queued=await Promise.all([post("/extractions",input),post("/extractions",input)]);
    expect(queued.map(x=>x.status)).toEqual([202,202]);expect(queued[0].body.data.id).toBe(queued[1].body.data.id);
    const worker={db,fileStorage:{read:async()=>createReadStream(fixture!)},audit:async()=>{audits++;},reportError:()=>{}};
    expect(await runBuildingExtraction(worker,new AbortController().signal)).toBe(true);
    const rows=(await pool.query("select * from projects_building_extraction_candidates")).rows;
    const rooms=rows.filter(r=>r.entity_type==="room"),elements=rows.filter(r=>r.entity_type==="element");
    const walls=elements.filter(r=>r.geometry.quality==="draft_wall"),assemblies=elements.filter(r=>r.geometry.quality==="construction_fragment_assembly");
    expect(rooms.length).toBeGreaterThan(0);expect(elements.length).toBeGreaterThan(0);
    expect(rooms.every(r=>r.status==="unreviewed" && ["anchor","enclosed_region","approximate_partition"].includes(r.geometry.quality))).toBe(true);
    expect(rooms.some(r=>r.geometry.quality==="anchor")).toBe(true);
    expect(rooms.some(r=>r.geometry.quality!=="anchor")).toBe(true);
    expect(walls.length).toBeGreaterThan(0);
    expect(walls.every(r=>r.status==="unreviewed"&&r.geometry.semanticKind==="draft_wall"&&r.geometry.constructionState==="proposed"&&r.geometry.phaseEvidence.status==="unreviewed"&&Array.isArray(r.geometry.polygon)&&r.geometry.polygon.length===4
      &&r.geometry.classification.sourcePolygonExact&&r.evidence[0].layerName.includes("Konstruktion")&&!Object.hasOwn(r.geometry,"thickness")&&!Object.hasOwn(r.geometry,"material"))).toBe(true);
    expect(assemblies.every(r=>r.status==="unreviewed"&&r.geometry.semanticKind==="construction_fragment"&&r.geometry.constructionState==="proposed"&&Array.isArray(r.geometry.polygons)&&r.geometry.polygons.length>0
      &&r.evidence[0].layerName.includes("Konstruktion"))).toBe(true);
    // Topology-v6 changed barrier inputs (curved/compound fills kept, hidden and existing-state layers excluded) and
    // opening detection; exact v5 reference counts no longer apply. v5 produced 74 room hypotheses from 91 labels.
    expect(walls.filter(r=>r.geometry.classification.evidenceTier==="high").length).toBeGreaterThan(0);
    expect(walls.every(r=>r.geometry.classification.thicknessBandCount>=1&&r.geometry.classification.minorDimensionBand>0)).toBe(true);
    const completedJob=(await pool.query("select result from projects_building_extractions where id=$1",[queued[0].body.data.id])).rows[0].result;
    expect(completedJob).toMatchObject({roomCandidateCount:91,topologyCoverage:{apartmentDomainCount:11,barrierScenario:"primary"}});
    expect(completedJob.roomHypothesisCount).toBeGreaterThanOrEqual(74);
    expect(completedJob.topologyCoverage.openingCount).toBeGreaterThan(0);
    // Magic selection floods the clicked room from the stored barriers; outline edits are logged as training data.
    const enclosed=rooms.slice(3).find(r=>r.geometry.quality==="enclosed_region")!,label=enclosed.geometry.labelRegion??enclosed.geometry.planRegion;
    const click={x:label.x+label.width/2,y:label.y+label.height/2};
    expect((await post("/magic-selection",{sourceVersionId:version,page:3,point:click},{"x-other":"1"})).status).toBe(404);
    expect((await post("/magic-selection",{sourceVersionId:version,page:2,point:click})).body.error.code).toBe("selection_unavailable");
    const magic=await post("/magic-selection",{sourceVersionId:version,page:3,point:click});
    expect(magic.status).toBe(200);expect(magic.body.data.status).toBe("found");
    const proposal=magic.body.data.options[0];
    expect(proposal.areaM2).toBeGreaterThan(0);expect(proposal.polygon.length).toBeGreaterThanOrEqual(4);
    const moved=proposal.polygon.map((p:any,i:number)=>i===0?{x:p.x+.002,y:p.y}:p);
    const outline={target:{type:"candidate",id:enclosed.id},polygon:moved,holes:[],method:"magic_selection",magic:{point:click,polygon:proposal.polygon,holes:proposal.holes}};
    expect((await post("/outline-edits",{...outline,baseRevision:1})).status).toBe(409);
    expect((await post("/outline-edits",{...outline,baseRevision:0,polygon:[moved[0],moved[1]]})).status).toBeGreaterThanOrEqual(400);
    const crossing=[{x:.1,y:.1},{x:.2,y:.2},{x:.2,y:.1},{x:.1,y:.2}];
    expect((await post("/outline-edits",{...outline,baseRevision:0,polygon:crossing})).body.error.code).toBe("invalid_outline");
    const edited=await post("/outline-edits",{...outline,baseRevision:0});
    expect(edited.status).toBe(200);expect(edited.body.data).toMatchObject({entityType:"candidate",entityId:enclosed.id,revision:1});
    const editedRow=(await pool.query("select status,geometry from projects_building_extraction_candidates where id=$1",[enclosed.id])).rows[0];
    expect(editedRow.status).toBe("unreviewed");
    expect(editedRow.geometry).toMatchObject({quality:"manual_outline",polygon:moved,outlineEdit:{method:"magic_selection",editCount:1}});
    const log=(await pool.query("select * from projects_building_outline_edits")).rows;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({target_type:"candidate",action:"reshape",method:"magic_selection",page:3,extractor_version:"topology-v9",
      before:{quality:"enclosed_region",polygon:enclosed.geometry.polygon},after:{polygon:moved},magic:{point:click,polygon:proposal.polygon},model_revision:1});
    expect(log[0].metrics.areaAfterM2).toBeGreaterThan(0);expect(log[0].metrics.vertexCountBefore).toBe(enclosed.geometry.polygon.length);
    const drawn=await post("/outline-edits",{baseRevision:1,target:{type:"new_room",storeyId:storey,sourceVersionId:version,page:3,name:"Drawn room"},polygon:proposal.polygon,method:"manual"});
    expect(drawn.status).toBe(201);
    const drawnRoom=(await pool.query("select name,geometry from projects_building_rooms where id=$1",[drawn.body.data.entityId])).rows[0];
    expect(drawnRoom).toMatchObject({name:"Drawn room",geometry:{quality:"manual_outline",source:{sourceVersionId:version,page:3}}});
    const reshaped=await post("/outline-edits",{baseRevision:2,target:{type:"room",id:drawn.body.data.entityId},polygon:moved,method:"manual"});
    expect(reshaped.status).toBe(200);
    expect((await pool.query("select action,before is not null as has_before from projects_building_outline_edits order by created_at")).rows.map(r=>[r.action,r.has_before])).toEqual([["reshape",true],["create",false],["reshape",true]]);
    await pool.query("delete from projects_building_rooms where id=$1",[drawn.body.data.entityId]);
    // Rewind the revision so the review assertions below keep their original numbering.
    await pool.query("delete from projects_building_revisions where model_id=$1",[model]);await pool.query("update projects_building_models set revision=0 where id=$1",[model]);
    const agentContext=await (await fetch(base+"/agent-context")).json();
    expect(agentContext.data.entities).toHaveLength(2); // building + storey; candidates are never canonical entities
    expect(agentContext.data.missingInputs).toHaveLength(0);
    expect(agentContext.data.draftCandidates).toHaveLength(rows.length);
    expect(agentContext.data.draftCandidates[0]).toMatchObject({reviewStatus:"unreviewed",sourceVersionId:version,page:3,
      deepLink:`/projects/${project}?view=building-model`});
    expect(agentContext.data.draftCandidates.every((candidate:any)=>candidate.candidateId && candidate.geometry.quality)).toBe(true);
    await pool.query("update projects_files set purpose='reference_report' where id=$1",[file]);
    const purposeChangedContext=await (await fetch(base+"/agent-context")).json();
    expect(purposeChangedContext.data.draftCandidates).toHaveLength(0);
    await pool.query("update projects_files set purpose='project_evidence' where id=$1",[file]);
    const candidate=rooms[0],review={baseRevision:0,decision:"approved",name:"Reviewed correction"};
    const reviews=await Promise.all([post(`/extraction-candidates/${candidate.id}/review`,review),post(`/extraction-candidates/${candidate.id}/review`,review)]);
    expect(reviews.map(r=>r.status).sort()).toEqual([200,409]);
    expect((await pool.query("select name,room_use,construction_state from projects_building_rooms")).rows).toEqual([{name:"Reviewed correction",room_use:null,construction_state:"unknown"}]);
    // Upgrade an older labels-only job in place; never replace reviewed candidate IDs.
    await pool.query("update projects_building_extraction_candidates set geometry=geometry-'constructionState'-'phaseEvidence' where id=$1",[walls[0].id]);
    await pool.query("update projects_building_extractions set extractor_version='labels-v1'");
    const upgraded=await post("/extractions",{...input,baseRevision:1});
    expect(upgraded.body.data.id).toBe(queued[0].body.data.id);expect(upgraded.body.data.extractorVersion).toBe("topology-v9");
    expect(await runBuildingExtraction(worker,new AbortController().signal)).toBe(true);
    expect((await pool.query("select count(*)::int as n from projects_building_extraction_candidates")).rows[0].n).toBe(rows.length);
    expect((await pool.query("select name,status from projects_building_extraction_candidates where id=$1",[candidate.id])).rows[0]).toEqual({name:"Reviewed correction",status:"approved"});
    expect((await pool.query("select geometry->>'constructionState' as state from projects_building_extraction_candidates where id=$1",[walls[0].id])).rows[0].state).toBe("proposed");
    expect((await pool.query("select geometry from projects_building_extraction_candidates where id=$1",[enclosed.id])).rows[0].geometry).toMatchObject({quality:"manual_outline",polygon:moved,topology:{status:"enclosed"}});
    expect((await pool.query("select name from projects_building_rooms")).rows).toEqual([{name:"Reviewed correction"}]);
    // Refreshing unreviewed hypotheses bumps the revision, so a review based on what the reviewer saw before is fenced.
    expect(Number((await pool.query("select revision from projects_building_models where id=$1",[model])).rows[0].revision)).toBe(2);
    const second=rooms[1];
    if(second)expect((await post(`/extraction-candidates/${second.id}/review`,{baseRevision:1,decision:"rejected"})).status).toBe(409);
    if(second)expect((await post(`/extraction-candidates/${second.id}/review`,{baseRevision:2,decision:"rejected"})).status).toBe(200);
    if(rooms[2]) {
      const target=(await pool.query("select id from projects_building_rooms")).rows[0].id;
      expect((await post(`/extraction-candidates/${rooms[2].id}/review`,{baseRevision:3,decision:"approved",targetEntityId:target,name:"Must not overwrite existing correction"})).status).toBe(200);
      expect((await pool.query("select name from projects_building_rooms")).rows).toEqual([{name:"Reviewed correction"}]);
    }
    const revision=async()=>Number((await pool.query("select revision from projects_building_models where id=$1",[model])).rows[0].revision);
    const footprintReview=await post(`/extraction-candidates/${walls[0].id}/review`,{baseRevision:await revision(),decision:"approved",name:"Reviewed draft wall"});
    expect(footprintReview.status).toBe(200);
    expect(footprintReview.body.data.entity).toMatchObject({buildingId:building,storeyId:storey,kind:"draft_wall",constructionState:"unknown",geometry:{quality:"draft_wall",semanticKind:"draft_wall"}});
    expect(footprintReview.body.data.entity.geometry.polygon).toEqual(walls[0].geometry.polygon);
    const fragmentReview=await post(`/extraction-candidates/${assemblies[0].id}/review`,{baseRevision:await revision(),decision:"approved",name:"Reviewed construction fragment"});
    expect(fragmentReview.status).toBe(200);
    expect(fragmentReview.body.data.entity).toMatchObject({buildingId:building,storeyId:storey,kind:"source_construction_fragment",
      geometry:{quality:"construction_fragment_assembly",semanticKind:"construction_fragment"}});
    expect(fragmentReview.body.data.entity.geometry.polygons).toEqual(assemblies[0].geometry.polygons);
    await pool.query("update projects_building_extractions set status='queued',lease_until=null");
    expect(await runBuildingExtraction(worker,new AbortController().signal)).toBe(true);
    expect((await pool.query("select count(*)::int as n from projects_building_extraction_candidates")).rows[0].n).toBe(rows.length);
    expect((await pool.query("select name,status from projects_building_extraction_candidates where id=$1",[walls[0].id])).rows[0]).toEqual({name:"Reviewed draft wall",status:"approved"});
    expect((await pool.query("select name,kind from projects_building_elements order by name")).rows).toEqual([
      {name:"Reviewed construction fragment",kind:"source_construction_fragment"},{name:"Reviewed draft wall",kind:"draft_wall"}]);
    const room=(await pool.query("select id from projects_building_rooms")).rows[0].id;
    const child=await post(`/rooms/${room}/elements`,{baseRevision:await revision(),stableKey:"manual-child",name:"Manual child",kind:"unknown"});
    expect(child.status).toBe(201);expect(child.body.data.created.buildingId).toBe(building);
    const property=await post("/properties",{baseRevision:await revision(),entityType:"room",entityId:room,propertyKey:"roomUse",value:"Sleeping",provenance:"manual",evidence:[{kind:"page",sourceVersionId:version,page:3}]});
    expect(property.status).toBe(201);
    const reviewPath=`/properties/${property.body.data.property.id}/versions/1/review`;
    expect((await post(reviewPath,{baseRevision:await revision(),reviewRevision:0,decision:"approved"})).status).toBe(200);
    expect((await pool.query("select room_use from projects_building_rooms where id=$1",[room])).rows[0].room_use).toBe("Sleeping");
    const beforeFailedReview=await revision();
    expect((await post(reviewPath,{baseRevision:beforeFailedReview,reviewRevision:0,decision:"rejected"})).status).toBe(409);
    expect(await revision()).toBe(beforeFailedReview);
    expect((await post(reviewPath,{baseRevision:await revision(),reviewRevision:1,decision:"rejected"})).status).toBe(200);
    expect((await pool.query("select room_use from projects_building_rooms where id=$1",[room])).rows[0].room_use).toBeNull();
    const beforeMissing=await revision();
    expect((await post(`/measurements/${crypto.randomUUID()}/review`,{baseRevision:beforeMissing,reviewRevision:0,decision:"approved"})).status).toBe(409);
    const missing=await fetch(base+`/room/${crypto.randomUUID()}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({baseRevision:beforeMissing,name:"Missing"})});
    expect(missing.status).toBe(404);expect(await revision()).toBe(beforeMissing);
    expect((await post("/reconciliations",{baseRevision:beforeMissing,sourceVersionId:version,sourceEntityKey:"bad-target",targetEntityType:"room",targetEntityId:crypto.randomUUID(),method:"manual",status:"accepted"})).status).toBe(422);
    expect((await post("/proposals",{baseRevision:beforeMissing,proposalType:"property",targetEntityType:"room",targetEntityId:crypto.randomUUID(),payload:{propertyKey:"roomUse",value:"invalid"}})).status).toBe(422);
    const badEvidenceProposal=await post("/proposals",{baseRevision:beforeMissing,proposalType:"property",targetEntityType:"room",targetEntityId:room,payload:{propertyKey:"roomUse",value:"invalid",evidence:[{kind:"page",sourceVersionId:crypto.randomUUID(),page:1}]}});
    expect(badEvidenceProposal.status).toBe(201);
    expect((await post(`/proposals/${badEvidenceProposal.body.data.id}/review`,{baseRevision:beforeMissing,decision:"approved"})).status).toBe(422);
    expect(await revision()).toBe(beforeMissing);
    expect(audits).toBeGreaterThan(3);
  }finally{server.close();await pool.end();await admin.pool.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.pool.end();}
},30000);

(local && fixture ? test : test.skip)("section heights persist source observations once and require separate property review", async () => {
  const namespace = `height_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(url!); await admin.pool.query(`CREATE SCHEMA ${namespace}`);
  const isolated = new URL(url!); isolated.searchParams.set("options", `-c search_path=${namespace}`);
  const { db, pool } = createDatabase(isolated.href);
  const tenant = crypto.randomUUID(), other = crypto.randomUUID(), project = crypto.randomUUID(), actor = crypto.randomUUID(),
    model = crypto.randomUUID(), building = crypto.randomUUID(), file = crypto.randomUUID(), version = crypto.randomUUID();
  const app = express(); app.use(express.json());
  app.use(createBuildingModelRouter(req => ({ db, tenantId: req.headers["x-other"] ? other : tenant, actorId: actor,
    requirePermission() { if (req.headers["x-denied"]) throw Object.assign(new Error("Forbidden"), { status: 403 }); },
    audit: async () => {}, validateCustomer: async () => false, customerNames: async () => ({}), fileStorage: {} as any })));
  app.use((e: any, _req: any, res: any, _next: any) => res.status(e.status ?? 500).json({ message: e.message }));
  const server = app.listen(0), base = `http://127.0.0.1:${(server.address() as any).port}/projects/${project}/building-model`;
  const post = async (path: string, body: unknown, headers = {}) => {
    const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  let calls = 0;
  try {
    for (const table of ["projects_projects", "projects_files", "projects_file_versions", "projects_source_models", "projects_source_pages",
      ...(await admin.pool.query("select tablename from pg_tables where schemaname='public' and tablename like 'projects_building_%'")).rows.map(r => r.tablename)]) {
      if (!/^projects_[a-z_]+$/.test(table)) throw new Error("Unexpected table");
      await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await pool.query("insert into projects_projects (id,tenant_id,name,created_by) values ($1,$2,'Height test',$3)", [project, tenant, actor]);
    await pool.query("insert into projects_building_models (id,tenant_id,project_id,created_by) values ($1,$2,$3,$4)", [model, tenant, project, actor]);
    await pool.query("insert into projects_building_buildings (id,tenant_id,model_id,stable_key,name,created_by) values ($1,$2,$3,'test','Haus B',$4)", [building, tenant, model, actor]);
    await pool.query("insert into projects_files (id,tenant_id,project_id,name,source_type,created_by) values ($1,$2,$3,'section.pdf','upload',$4)", [file, tenant, project, actor]);
    await pool.query("insert into projects_file_versions (id,tenant_id,file_id,version,status,storage_key,mime_type,created_by) values ($1,$2,$3,1,'ready','test','application/pdf',$4)", [version, tenant, file, actor]);
    await pool.query("insert into projects_source_models (version_id,tenant_id,status,metadata) values ($1,$2,'complete',$3)", [version, tenant, JSON.stringify({ automaticBuildingModel: { modelId: model, floorPlanPages: [] } })]);
    await pool.query("insert into projects_building_plan_sources (tenant_id,model_id,source_version_id,page,created_by) values ($1,$2,$3,1,$4)", [tenant, model, version, actor]);
    // The provider is stubbed: this test validates rendering/persistence/review, not visual semantic accuracy.
    await pool.query("insert into projects_source_pages (version_id,tenant_id,page,content) values ($1,$2,1,$3)", [version, tenant, JSON.stringify({ status: "available", text: "Schnitt B-B Höhe 954 cm First 13,80 m" })]);
    expect((await post("/height-extractions", { sourceVersionId: version }, { "x-other": "1" })).status).toBe(404);
    expect((await post("/height-extractions", { sourceVersionId: version }, { "x-denied": "1" })).status).toBe(403);
    expect((await post("/height-extractions", { sourceVersionId: version })).status).toBe(202);
    const height = { kind: "fire_height", value: 954, unit: "cm", unitBasis: "explicit", quote: "Höhe 954 cm", buildingLabel: "Haus B", storeyLabel: "DG",
      upperReference: "highest_habitable_floor", lowerReference: "mean_terrain", floorBasis: "structural", constructionState: "proposed",
      region: { x: .1, y: .2, width: .4, height: .5 }, reason: "Printed dimension with explicit endpoints." };
    const worker = { db, fileStorage: { read: async () => createReadStream(fixture!) }, audit: async () => {}, reportError: () => {},
      structureDocument: async (input: any) => {
        calls++; expect(input.task).toBe("plan_heights"); expect(input.image.data.length).toBeGreaterThan(100);
        return { status: "completed" as const, output: { observations: [height,
          { ...height, kind: "ridge_height", upperReference: "ridge", value: 13.8, unit: "m", quote: "First 13,80 m" }], gaps: [] },
          metadata: { provider: "test", model: "height-fixture", usage: { inputTokens: 100, outputTokens: 50 } } };
      } };
    expect(await runPlanHeightExtraction(worker, new AbortController().signal)).toBe(true);
    expect(await runPlanHeightExtraction(worker, new AbortController().signal)).toBe(false);
    expect(calls).toBe(1);
    expect((await post("/height-extractions", { sourceVersionId: version })).body.data).toEqual({ status: "complete", reused: true });
    const metadata = (await pool.query("select metadata from projects_source_models")).rows[0].metadata;
    expect(metadata.heightExtraction.pages[0]).toMatchObject({ status: "completed", observations: [height, expect.objectContaining({ kind: "ridge_height" })], metadata: { model: "height-fixture" } });
    expect((await pool.query("select count(*)::int n from projects_building_property_versions")).rows[0].n).toBe(0);
    const selection = { baseRevision: 0, buildingId: building, sourceVersionId: version, page: 1, observationIndex: 0 };
    expect((await post("/height-observations", { ...selection, observationIndex: 1 })).status).toBe(422);
    expect((await post("/height-observations", { ...selection, sourceVersionId: crypto.randomUUID() })).status).toBe(422);
    expect((await pool.query("select revision from projects_building_models")).rows[0].revision).toBe(0);
    const proposed = await post("/height-observations", selection);
    expect(proposed.status).toBe(201);
    expect(proposed.body.data.version).toMatchObject({ value: 9.54, unit: "m", provenance: "inferred", reviewStatus: "unreviewed", evidence: [{ sourceVersionId: version, page: 1, quote: "Höhe 954 cm" }] });
    expect((await post("/height-observations", { ...selection, baseRevision: 1 })).body.error.code).toBe("height_exists");
    expect((await pool.query("select revision from projects_building_models")).rows[0].revision).toBe(1);
    const review = await post(`/properties/${proposed.body.data.property.id}/versions/1/review`, { baseRevision: 1, reviewRevision: 0, decision: "approved" });
    expect(review.status).toBe(200);
    expect((await pool.query("select review_status from projects_building_property_versions")).rows[0].review_status).toBe("approved");
    // An expired pre-dispatch claim is made terminal, not dispatched again.
    await pool.query("update projects_source_models set metadata=jsonb_set(metadata,'{heightExtraction}', $1::jsonb)", [JSON.stringify({ version: "section-heights-v1", status: "processing", claimedAt: "2020-01-01T00:00:00Z", pages: [{ page: 1, status: "outcome_unknown", observations: [], gaps: ["Interrupted"] }] })]);
    expect(await runPlanHeightExtraction(worker, new AbortController().signal)).toBe(true);
    expect(await runPlanHeightExtraction(worker, new AbortController().signal)).toBe(false);
    expect(calls).toBe(1);
  } finally { server.close(); await pool.end(); await admin.pool.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.pool.end(); }
}, 60000);
