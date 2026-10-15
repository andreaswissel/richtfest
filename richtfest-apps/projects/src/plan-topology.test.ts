import { expect, test } from "bun:test";
import { planLabels, parsePlanBbox } from "./plan-extraction";
import { extractPlanFootprints, type PlanFillRegion, type PlanFootprint } from "./plan-footprints";
import { draftWallEvidence, inferPlanTopology, printedAreaObservations } from "./plan-topology";
const rectangle=(x:number,y:number,w:number,h:number)=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
const fill:PlanFillRegion={sourceKey:"source-fill",layerId:"fill",layerName:"Füllflächen",fillRule:"evenodd",rings:[rectangle(.1,.1,.8,.8)]};
const word=(text:string,x:number,y:number)=>({text,x,y,width:.03,height:.01});
const footprint=(key:string,x:number,y:number,w:number,h:number):PlanFootprint=>({sourceKey:key,entityType:"element",name:key,layerId:"construction",layerName:"Konstruktion",quote:"Source polygon",geometry:{quality:"footprint",coordinateSpace:"normalized-page",polygon:rectangle(x,y,w,h),planRegion:{x,y,width:w,height:h},limitations:"Source footprint"}});

test("source-filled shared space yields explicit partitions, not walls or measured rooms",()=>{
  const sourceFill={...fill,rings:[rectangle(.1,.1,.4,.15)]};
  const labels=planLabels([word("Bad",.2,.15),word("Schlafen",.4,.15),word("Balkon",.95,.3)]);
  const result=inferPlanTopology(labels,[],[],100,[],0,[sourceFill],1.5);
  expect(result.coverage.conflicting).toBe(2);expect(result.coverage.outside_source_fill).toBe(1);
  expect(result.rooms.slice(0,2).every(r=>r.geometry.quality==="approximate_partition")).toBe(true);
  expect(result.rooms[0].geometry.topology.competingSourceKeys).toEqual([result.rooms[1].sourceKey]);
  expect(result.rooms[2].geometry.quality).toBe("anchor");
  expect(result.coverage.relationships).toContain("Not established");
  expect(result.rooms[0]).not.toHaveProperty("area");
});
test("closed source barrier separates seeds; assemblies preserve original member polygons",()=>{
  const sourceFill={...fill,rings:[rectangle(.1,.1,.4,.25)]};
  const wall=footprint("wall",.29,.1,.02,.25),extension=footprint("extension",.31,.2,.08,.02);
  const result=inferPlanTopology(planLabels([word("Bad",.2,.2),word("Schlafen",.4,.2)]),[wall,extension],[],100,[],0,[sourceFill]);
  expect(result.coverage.enclosed).toBe(2);
  expect(result.rooms.every(r=>r.geometry.quality==="enclosed_region")).toBe(true);
  expect(result.assemblies).toHaveLength(2);
  expect(result.assemblies.every(a=>a.geometry.quality==="draft_wall"&&a.geometry.semanticKind==="draft_wall")).toBe(true);
  expect(result.assemblies.map(a=>"polygon" in a.geometry&&a.geometry.polygon)).toEqual([wall.geometry.polygon,extension.geometry.polygon]);
});
test("even-odd source holes survive contours and are never filled as room area",()=>{
  const compact={...fill,rings:[rectangle(.1,.1,.2,.2),rectangle(.2,.2,.05,.05)]};
  const result=inferPlanTopology(planLabels([word("Bad",.15,.15)]),[],[],100,[],0,[compact]);
  expect(result.rooms[0].geometry.holes).toHaveLength(1);
});
test("wall semantics require an exact elongated rectangular construction fill and never merge fragments through a wall",()=>{
  const left=footprint("left",.30,.40,.04,.04),wall=footprint("wall",.34,.35,.01,.20),right=footprint("right",.35,.50,.04,.04);
  const result=inferPlanTopology([], [left,wall,right],[],200);
  expect(draftWallEvidence(wall)).toMatchObject({wallLike:true,method:"elongated_rectangular_construction_fill",sourcePolygonExact:true});
  expect(draftWallEvidence(left).wallLike).toBe(false);
  expect(result.coverage).toMatchObject({wallCount:1,unsupportedFootprintCount:2,fragmentAssemblyCount:2});
  const fragments=result.assemblies.filter(a=>a.geometry.quality==="construction_fragment_assembly");
  expect(fragments).toHaveLength(2);
  expect(fragments.every(a=>"polygons" in a.geometry&&a.geometry.polygons.length===1&&a.geometry.semanticKind==="construction_fragment")).toBe(true);
});
test("oversized inferred regions remain unresolved anchors rather than whole-apartment room polygons",()=>{
  const result=inferPlanTopology(planLabels([word("Abstellr.",.2,.2)]),[],[],100,[],0,[fill]);
  expect(result.rooms[0].geometry.quality).toBe("anchor");
  expect(result.rooms[0].geometry.topology).toMatchObject({status:"oversized_unresolved",method:"oversized_region_guard"});
  expect(result.rooms[0].geometry.limitations).toContain("multiple rooms or a whole apartment");
});
test("area observations prefer aligned next-line values and reject summary annotations",()=>{
  const labels=planLabels([word("Bad",.2,.2)]);
  const observations=printedAreaObservations(labels,[word("4.81",.2,.212),word("m²",.231,.212),word("Wfl.",.18,.225),word("52.30",.215,.225),word("m²",.246,.225)]);
  expect(observations.get(labels[0].sourceKey)).toMatchObject({value:4.81,status:"unreviewed",provenance:"inferred"});
});
test("page-local area-ratio QC demotes only severe merge/split outliers and never treats printed area as scale proof",()=>{
  const sourceFill={...fill,rings:[rectangle(.1,.1,.5,.1)]};
  const xs=[.15,.24,.33,.42,.51],labels=xs.map((x,index)=>word(index?"Bad":"Schlafen",x,.14));
  const areas=xs.flatMap((x,index)=>[word(index===4?"100.00":"10.00",x,.152),word("m²",x+.031,.152)]);
  const result=inferPlanTopology(planLabels(labels),[],[...labels,...areas],200,[],0,[sourceFill]);
  expect(result.coverage).toMatchObject({areaRatioSampleCount:5,area_ratio_outlier:1,approximateRegionCount:4,unresolvedRegionCount:1});
  const outlier=result.rooms.find(room=>room.geometry.topology.status==="area_ratio_outlier");
  expect(outlier).toMatchObject({geometry:{quality:"anchor",topology:{method:"area_ratio_outlier_guard"},printedArea:{value:100},areaRatioQc:{status:"unreviewed",sampleCount:5}}});
  expect(outlier?.geometry).not.toHaveProperty("polygon");
  expect(outlier&&"areaRatioQc" in outlier.geometry?outlier.geometry.areaRatioQc.limitations:"").toContain("does not establish scale");
});

const reference=process.env.RICHTFEST_REFERENCE_PLAN_PDF;
test.skipIf(!reference)("reference PDF retains measured source coverage without pretending partitions are source boundaries",async()=>{
  const xml=Bun.spawnSync(["pdftotext","-f","3","-l","3","-bbox",reference!,"-"]);
  expect(xml.exitCode).toBe(0);
  const words=parsePlanBbox(xml.stdout.toString()),labels=planLabels(words);
  const geometry=await extractPlanFootprints(reference!,3,new AbortController().signal);
  const result=inferPlanTopology(labels,geometry.candidates,words,1200,geometry.supplementaryBarriers,0,geometry.fillRegions,geometry.pageAspectRatio);
  expect(labels).toHaveLength(91);expect(labels.filter(l=>l.name==="Balkon")).toHaveLength(11);
  expect(geometry.candidates).toHaveLength(235);expect(geometry.fillRegions).toHaveLength(14);
  expect(result.coverage).toMatchObject({enclosed:0,conflicting:48,area_ratio_outlier:28,outside_source_fill:15,groupedRoomCount:76,approximateRegionCount:48,
    unresolvedRegionCount:43,wallCount:164,highEvidenceWallCount:164,mediumEvidenceWallCount:0,fragmentAssemblyCount:64,unsupportedFootprintCount:71,assemblyCount:228,printedAreaCount:90});
  expect(result.rooms.filter(r=>r.geometry.quality==="approximate_partition")).toHaveLength(48);
  // These source room annotations were previously suppressed by nearby apartment summaries.
  // Verify the nine audited additions as actual next-line source observations, not summary values.
  const livingAreas=result.rooms.filter(r=>r.name.startsWith("Wo.")).map(r=>r.geometry.printedArea?.value);
  for(const value of [27.32,36.28,24.93,28.58,37.67,24.99])expect(livingAreas).toContain(value);
  expect(livingAreas.filter(v=>v===27.32)).toHaveLength(2);
  for(const value of [4.49,5.02])expect(result.rooms.filter(r=>r.name==="Diele").map(r=>r.geometry.printedArea?.value)).toContain(value);
  expect(result.rooms.filter(r=>r.name==="Balkon"&&!r.geometry.printedArea)).toHaveLength(1);
  expect(result.assemblies.flatMap(a=>a.geometry.sourceFootprintKeys)).toHaveLength(235);
  const walls=result.assemblies.filter(a=>a.geometry.quality==="draft_wall");
  expect(walls).toHaveLength(164);
  expect(walls.every(w=>"polygon" in w.geometry&&w.geometry.polygon.length===4&&w.geometry.semanticKind==="draft_wall"
    &&w.geometry.classification.sourcePolygonExact&&!Object.hasOwn(w.geometry,"thickness")&&!Object.hasOwn(w.geometry,"material"))).toBe(true);
  for(const room of result.rooms) for(const point of room.geometry.polygon??[])expect(point.x>=0&&point.x<=1&&point.y>=0&&point.y<=1).toBe(true);
});
test.skipIf(!reference)("reference basement page demotes the audited whole-apartment false room region",async()=>{
  const xml=Bun.spawnSync(["pdftotext","-f","1","-l","1","-bbox",reference!,"-"]);
  expect(xml.exitCode).toBe(0);
  const words=parsePlanBbox(xml.stdout.toString()),labels=planLabels(words);
  const geometry=await extractPlanFootprints(reference!,1,new AbortController().signal);
  const result=inferPlanTopology(labels,geometry.candidates,words,1200,geometry.supplementaryBarriers,0,geometry.fillRegions,geometry.pageAspectRatio);
  const oversized=result.rooms.filter(room=>room.geometry.topology.status==="oversized_unresolved");
  expect(oversized.map(room=>room.name)).toEqual(["Abstellr."]);
  expect(oversized[0].geometry.quality).toBe("anchor");
  expect(result.coverage).toMatchObject({oversized_unresolved:1,area_ratio_outlier:5,approximateRegionCount:25,unresolvedRegionCount:15,wallCount:8});
  expect(Math.max(...result.rooms.flatMap(room=>room.geometry.polygon?[room.geometry.planRegion.width*room.geometry.planRegion.height]:[]))).toBeLessThan(.04);
});
