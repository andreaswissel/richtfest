import { expect, test } from "bun:test";
import express from "express";
import { createReadStream } from "node:fs";
import { createBuildingModelRouter } from "@richtfest/projects/building-model";
import { runBuildingExtraction } from "@richtfest/projects/building-extraction";
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
    expect(rooms.some(r=>r.geometry.quality==="approximate_partition")).toBe(true);
    expect(walls).toHaveLength(164);expect(assemblies).toHaveLength(64);
    expect(walls.every(r=>r.status==="unreviewed"&&r.geometry.semanticKind==="draft_wall"&&Array.isArray(r.geometry.polygon)&&r.geometry.polygon.length===4
      &&r.geometry.classification.sourcePolygonExact&&r.evidence[0].layerName.includes("Konstruktion")&&!Object.hasOwn(r.geometry,"thickness")&&!Object.hasOwn(r.geometry,"material"))).toBe(true);
    expect(assemblies.every(r=>r.status==="unreviewed"&&r.geometry.semanticKind==="construction_fragment"&&Array.isArray(r.geometry.polygons)&&r.geometry.polygons.length>0
      &&r.evidence[0].layerName.includes("Konstruktion"))).toBe(true);
    expect(walls.filter(r=>r.geometry.classification.evidenceTier==="high")).toHaveLength(164);
    expect(walls.every(r=>r.geometry.classification.thicknessBandCount>=1&&r.geometry.classification.minorDimensionBand>0)).toBe(true);
    const completedJob=(await pool.query("select result from projects_building_extractions where id=$1",[queued[0].body.data.id])).rows[0].result;
    expect(completedJob).toMatchObject({candidateCount:319,roomCandidateCount:91,roomHypothesisCount:48,unresolvedAnchorCount:43,
      draftWallCount:164,constructionFragmentCount:64,topologyCoverage:{area_ratio_outlier:28,wallCount:164,
        highEvidenceWallCount:164,mediumEvidenceWallCount:0,fragmentAssemblyCount:64,sourceFootprintCount:235}});
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
    await pool.query("update projects_building_extractions set extractor_version='labels-v1'");
    const upgraded=await post("/extractions",{...input,baseRevision:1});
    expect(upgraded.body.data.id).toBe(queued[0].body.data.id);expect(upgraded.body.data.extractorVersion).toBe("topology-v3");
    expect(await runBuildingExtraction(worker,new AbortController().signal)).toBe(true);
    expect((await pool.query("select count(*)::int as n from projects_building_extraction_candidates")).rows[0].n).toBe(rows.length);
    expect((await pool.query("select name,status from projects_building_extraction_candidates where id=$1",[candidate.id])).rows[0]).toEqual({name:"Reviewed correction",status:"approved"});
    expect((await pool.query("select name from projects_building_rooms")).rows).toEqual([{name:"Reviewed correction"}]);
    const second=rooms[1];
    if(second)expect((await post(`/extraction-candidates/${second.id}/review`,{baseRevision:1,decision:"rejected"})).status).toBe(200);
    if(rooms[2]) {
      const target=(await pool.query("select id from projects_building_rooms")).rows[0].id;
      expect((await post(`/extraction-candidates/${rooms[2].id}/review`,{baseRevision:2,decision:"approved",targetEntityId:target,name:"Must not overwrite existing correction"})).status).toBe(200);
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
