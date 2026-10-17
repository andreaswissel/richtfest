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
  expect(result.coverage.relationships).toContain("Inferred only");
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
test("printed areas guide partition capacities before page-local QC",()=>{
  const sourceFill={...fill,rings:[rectangle(.1,.1,.5,.1)]};
  const xs=[.15,.24,.33,.42,.51],labels=xs.map((x,index)=>word(index?"Bad":"Schlafen",x,.14));
  const areas=xs.flatMap((x,index)=>[word(index===4?"100.00":"10.00",x,.152),word("m²",x+.031,.152)]);
  const result=inferPlanTopology(planLabels(labels),[],[...labels,...areas],200,[],0,[sourceFill]);
  expect(result.coverage).toMatchObject({areaRatioSampleCount:5,printedAreaCount:5});
  expect(result.rooms.filter(r=>r.geometry.polygon).length).toBeGreaterThan(0);
  for(const r of result.rooms.filter(r=>r.geometry.polygon))expect(r.geometry).toMatchObject({capacityQc:{status:"unreviewed"}});
});

test("open-plan rooms are split by a straight wall-to-wall cut, not a staircase seam",()=>{
  // A 100 m² living room opening into a 30 m² corridor at x=.3 (1 page-height unit = 50 m).
  const sourceFill={...fill,rings:[[{x:.1,y:.1},{x:.5,y:.1},{x:.5,y:.16},{x:.3,y:.16},{x:.3,y:.3},{x:.1,y:.3}]]};
  const labels=[word("Wohnen",.17,.2),word("Flur",.42,.12)];
  const areas=[word("100,00",.17,.212),word("m²",.201,.212),word("30,00",.42,.132),word("m²",.451,.132)];
  const result=inferPlanTopology(planLabels(labels),[],[...labels,...areas],200,[],0,[sourceFill],1,undefined,{metresPerPageHeight:50});
  expect(result.coverage).toMatchObject({straightSeamCount:1});
  const flur=result.rooms.find(r=>r.name==="Flur")!.geometry,wohnen=result.rooms.find(r=>r.name==="Wohnen")!.geometry;
  expect(flur).toMatchObject({quality:"approximate_partition"});
  // The seam is one vertical line near the junction (area-guided); a geodesic seam steps diagonally through many x positions.
  const seamX=Math.min(...flur.polygon!.map(p=>p.x));
  expect(seamX).toBeGreaterThan(.29);expect(seamX).toBeLessThan(.35);
  expect(new Set(flur.polygon!.map(p=>p.x.toFixed(3))).size).toBeLessThanOrEqual(3);
  expect(wohnen.polygon!.filter(p=>p.x>.31).every(p=>Math.abs(p.x-seamX)<1e-9)).toBe(true);
});

const reference=process.env.RICHTFEST_REFERENCE_PLAN_PDF;
test("touching apartment domains stay separate and decorative overlaps cannot steal ownership",()=>{
  const a={...fill,sourceKey:"a",rings:[rectangle(.1,.1,.2,.2)]},b={...fill,sourceKey:"b",rings:[rectangle(.3,.1,.2,.2)]};
  const decoration={...fill,sourceKey:"decoration",rings:[rectangle(.19,.14,.03,.03)]};
  const words=[word("WE 1",.12,.12),word("WE 2",.32,.12),word("Bad",.19,.15),word("Schlafen",.22,.23),word("Bad",.35,.15),word("Schlafen",.4,.23)];
  const result=inferPlanTopology(planLabels(words),[],words,200,[],0,[a,b,decoration]);
  expect(result.coverage.apartmentDomainCount).toBe(2);
  expect(result.rooms.map(r=>r.geometry.groupLabel)).toEqual(["WE 1","WE 1","WE 2","WE 2"]);
  for(const r of result.rooms)for(const p of r.geometry.polygon??[])expect(r.geometry.groupLabel==="WE 1"?p.x<=.3:p.x>=.3).toBe(true);
});
test("alternative construction states are never unioned with primary barriers",()=>{
  const labels=planLabels([word("Bad",.15,.15),word("Schlafen",.35,.15)]),f={...fill,rings:[rectangle(.1,.1,.35,.1)]};
  const alternative=footprint("alternate",.27,.1,.01,.1);
  const result=inferPlanTopology(labels,[],[],200,[alternative],0,[f]);
  expect(result.coverage).toMatchObject({conflicting:2,supplementaryBarrierCount:0,alternativeBarrierCount:1,barrierScenario:"primary"});
});
test("door gap closing only changes segmentation and keeps exact source polygons",()=>{
  const sources=[footprint("top",.25,.1,.01,.09),footprint("bottom",.25,.21,.01,.09),footprint("edge",.1,.1,.01,.2)];
  const result=inferPlanTopology(planLabels([word("Bad",.15,.15),word("Schlafen",.32,.15)]),sources,[],200,[],0,[{...fill,rings:[rectangle(.1,.1,.3,.2)]}]);
  expect(result.coverage.closeRadius).toBeGreaterThan(0);
  expect(result.coverage.enclosed).toBe(2);
  expect(result.assemblies.map(a=>"polygon" in a.geometry?a.geometry.polygon:null)).toEqual(sources.map(f=>f.geometry.polygon));
});
test("openings are measured in page-aspect units, so vertical and horizontal gaps close alike on landscape sheets",()=>{
  // Physical wall thickness .01 page heights; every gap is 6 thicknesses wide, the last pair 20.
  const A=1.414,t=.01,gap=6*t,polygonOf=(x:number,y:number,w:number,h:number)=>footprint(`${x},${y}`,x,y,w,h);
  const horizontal=[polygonOf(.1,.2,.2,t),polygonOf(.3+gap/A,.2,.2,t)];
  const vertical=[polygonOf(.7,.1,t/A,.2),polygonOf(.7,.3+gap,t/A,.2)];
  const tooWide=[polygonOf(.1,.8,.1,t),polygonOf(.2+20*t/A,.8,.1,t)];
  const result=inferPlanTopology([],[...horizontal,...vertical,...tooWide],[],800,[],0,[],A);
  expect(result.coverage.openingCount).toBe(2);
  const evidence=result.coverage.openingEvidence;
  expect(evidence.map(o=>o.wallAxis).sort()).toEqual(["horizontal","vertical"]);
  for(const o of evidence){expect(o.widthToJamb).toBeCloseTo(6,3);expect(o.segmentationOnly).toBe(true);expect(o.sourceKeys).toHaveLength(2);}
});
test("a wall end that butts into another wall is not an opening jamb",()=>{
  // Two colinear walls end on the faces of a crossing corridor wall pair: no opening across the corridor.
  const result=inferPlanTopology([],[footprint("upper",.3,.1,.01,.2),footprint("corridor-top",.1,.3,.5,.01),
    footprint("corridor-bottom",.1,.36,.5,.01),footprint("lower",.3,.37,.01,.2)],[],400);
  expect(result.coverage.openingCount).toBe(0);
});
test("diagonally touching columns inside a room no longer break boundary tracing",()=>{
  const columns=[footprint("a",.15,.15,.01,.01),footprint("b",.16,.16,.01,.01)];
  const result=inferPlanTopology(planLabels([word("Bad",.12,.12)]),columns,[],100,[],0,[{...fill,rings:[rectangle(.1,.1,.2,.2)]}]);
  expect(result.rooms[0].geometry.quality).toBe("enclosed_region");
  expect(result.coverage.trace_failed).toBe(0);
  expect(result.rooms[0].geometry.holes?.length).toBeGreaterThan(0);
});
test("shape QC accepts rectangular and legitimate L-shaped source-relative rooms",()=>{
  const rectangular=inferPlanTopology(planLabels([word("Bad",.15,.15)]),[],[],300,[],0,[{...fill,rings:[rectangle(.1,.1,.2,.2)]}]);
  expect(rectangular.rooms[0].geometry.quality).toBe("enclosed_region");
  expect(rectangular.rooms[0].geometry.shapeQc).toMatchObject({status:"unreviewed",rectilinearEdgeFraction:1,narrowLobeSignal:false,severeConcavity:false});
  expect(rectangular.rooms[0].geometry.shapeQc?.convexityRatio).toBeCloseTo(1,5);
  const lShape=[{x:.1,y:.1},{x:.3,y:.1},{x:.3,y:.18},{x:.18,y:.18},{x:.18,y:.3},{x:.1,y:.3}];
  const lShaped=inferPlanTopology(planLabels([word("Schlafen",.13,.13)]),[],[],300,[],0,[{...fill,rings:[lShape]}]);
  expect(lShaped.rooms[0].geometry.quality).toBe("enclosed_region");
  expect(lShaped.rooms[0].geometry.shapeQc).toMatchObject({status:"unreviewed",rectilinearEdgeFraction:1,narrowLobeSignal:false});
  expect(lShaped.rooms[0].geometry.shapeQc?.convexityRatio).toBeCloseTo(1.28125,2);
});
test("shape QC demotes an extreme doorway tendril but keeps a long L-shaped corridor",()=>{
  const tendril=[{x:.1,y:.1},{x:.3,y:.1},{x:.3,y:.12},{x:.12,y:.12},{x:.12,y:.3},{x:.1,y:.3}];
  const corridor=inferPlanTopology(planLabels([word("Flur",.105,.105)]),[],[],300,[],0,[{...fill,rings:[tendril]}]);
  expect(corridor.rooms[0].geometry.quality).toBe("enclosed_region");
  const result=inferPlanTopology(planLabels([word("Bad",.105,.105)]),[],[],300,[],0,[{...fill,rings:[tendril]}]);
  expect(result.rooms[0].geometry.quality).toBe("anchor");
  expect(result.rooms[0].geometry.topology).toMatchObject({status:"shape_outlier",method:"shape_qc_guard"});
  expect(result.rooms[0].geometry.shapeQc).toMatchObject({status:"severe",severeConcavity:true});
  expect(result.rooms[0].geometry).not.toHaveProperty("polygon");
});
test("10 and 30 square metre observations guide constrained area capacities",()=>{
  const words=[word("Bad",.14,.14),word("Schlafen",.34,.14),word("10.00",.14,.152),word("m²",.171,.152),word("30.00",.34,.152),word("m²",.371,.152)];
  const result=inferPlanTopology(planLabels(words),[],words,200,[],0,[{...fill,rings:[rectangle(.1,.1,.35,.1)]}]);
  expect(result.rooms.every(r=>r.geometry.polygon)).toBe(true);
  const area=(points:{x:number;y:number}[])=>Math.abs(points.reduce((s,p,i)=>{const q=points[(i+1)%points.length];return s+p.x*q.y-p.y*q.x;},0))/2;
  const ratio=area(result.rooms[1].geometry.polygon!)/area(result.rooms[0].geometry.polygon!);
  expect(ratio).toBeGreaterThan(2.5);expect(ratio).toBeLessThan(3.5);
});
test("duplicate living kitchens flag a group conflict; wall/text collisions remain fragments",()=>{
  const words=[word("WE 1",.11,.11),word("Wo.- Es.- Ko.",.15,.15),word("Wo.- Es.- Ko.",.3,.15)];
  const result=inferPlanTopology(planLabels(words),[footprint("text-collision",.14,.154,.08,.002)],words,200,[],0,[{...fill,rings:[rectangle(.1,.1,.3,.1)]}]);
  expect(result.coverage.wallCount).toBe(0);
  expect(result.coverage.unsupportedFootprintCount).toBe(1);
  for(const r of result.rooms)expect(r.geometry).toMatchObject({semanticQc:{duplicateLivingKitchen:true,status:"group_conflict"}});
});
test.skipIf(!reference)("page two retains all annotations and isolates apartment domains",async()=>{
  const xml=Bun.spawnSync(["pdftotext","-f","2","-l","2","-bbox",reference!,"-"]);
  const words=parsePlanBbox(xml.stdout.toString()),labels=planLabels(words);
  const geometry=await extractPlanFootprints(reference!,2,new AbortController().signal);
  const result=inferPlanTopology(labels,geometry.candidates,words,1200,geometry.supplementaryBarriers,0,geometry.fillRegions,geometry.pageAspectRatio,undefined,{doorSwings:geometry.doorSwings,barrierLines:geometry.barrierLines,metresPerPageHeight:geometry.pageHeightPoints/72*.0254*100});
  // Topology-v7 (stroked partitions, segmented door arcs, furniture gaps): 87 labels, 75 polygons on the reference PDF.
  expect(result.coverage.labelCount).toBeGreaterThanOrEqual(87);
  expect(result.coverage).toMatchObject({apartmentDomainCount:11,supplementaryBarrierCount:0});
  expect(result.coverage.approximateRegionCount).toBeGreaterThanOrEqual(75);
  expect(result.rooms.filter(r=>r.name==="Garderobe")).toHaveLength(1);
  expect(result.rooms.filter(r=>r.geometry.polygon).every(r=>r.geometry.groupLabel&&r.geometry.topology.apartmentOwner===r.geometry.groupSourceKey)).toBe(true);
  expect(new Set(result.rooms.flatMap(r=>r.geometry.groupLabel?[r.geometry.groupLabel]:[]))).toEqual(new Set(Array.from({length:11},(_,i)=>`WE ${i+1}`)));
  expect(result.rooms.filter(r=>r.geometry.polygon&&(r.geometry as {semanticQc?:{duplicateLivingKitchen?:boolean}}).semanticQc?.duplicateLivingKitchen)).toHaveLength(0);
  expect(result.coverage.highEvidenceWallCount).toBeLessThan(result.coverage.wallCount);
  expect(result.coverage.openingCount).toBeGreaterThan(0);
  const sleeping6=result.rooms.find(r=>r.name==="Schlafen"&&r.geometry.groupLabel==="WE 6");
  expect(sleeping6?.geometry.polygon).toBeDefined();
  expect(Math.min(...sleeping6!.geometry.polygon!.map(point=>point.y))).toBeGreaterThanOrEqual(.445);
  expect(result.assemblies.flatMap(a=>a.geometry.sourceFootprintKeys)).toHaveLength(geometry.candidates.length);
  const collision=geometry.candidates.find(f=>Math.abs(f.geometry.planRegion.x-.355895)<.00001&&Math.abs(f.geometry.planRegion.y-.411246)<.00001);
  expect(collision).toBeDefined();
  // This source polygon is above the native Bad/Flur boxes; do not invent a collision.
  expect(result.assemblies.find(a=>a.geometry.sourceFootprintKeys.includes(collision!.sourceKey))).toBeDefined();
  expect(result.rooms.filter(r=>r.geometry.groupLabel==="WE 5").every(r=>r.geometry.groupAssociationMethod==="bbox_summary_plus_exact_area_closure")).toBe(true);
  const scaled=inferPlanTopology(labels,geometry.candidates,words,1200,geometry.supplementaryBarriers,0,geometry.fillRegions,geometry.pageAspectRatio,geometry.pageWidthPoints*geometry.pageHeightPoints*(.0254/72*100)**2);
  for(const room of scaled.rooms.filter(r=>r.geometry.polygon))expect(room.geometry).toMatchObject({printedScaleQc:{status:"unreviewed"}});
  console.info("page2",{labels:result.coverage.labelCount,areas:result.coverage.printedAreaCount,domains:result.coverage.apartmentDomainCount,unscaledPolygons:result.coverage.approximateRegionCount,scaledPolygons:scaled.coverage.approximateRegionCount,scaledAnchors:scaled.coverage.unresolvedRegionCount,walls:result.coverage.wallCount,highWalls:result.coverage.highEvidenceWallCount});
});
test.skipIf(!reference)("reference PDF retains measured source coverage without pretending partitions are source boundaries",async()=>{
  const xml=Bun.spawnSync(["pdftotext","-f","3","-l","3","-bbox",reference!,"-"]);
  expect(xml.exitCode).toBe(0);
  const words=parsePlanBbox(xml.stdout.toString()),labels=planLabels(words);
  const geometry=await extractPlanFootprints(reference!,3,new AbortController().signal);
  const result=inferPlanTopology(labels,geometry.candidates,words,1200,geometry.supplementaryBarriers,0,geometry.fillRegions,geometry.pageAspectRatio);
  expect(labels.length).toBeGreaterThanOrEqual(91);expect(labels.filter(l=>l.name==="Balkon")).toHaveLength(11);
  expect(geometry.candidates.length).toBeGreaterThan(0);expect(geometry.fillRegions).toHaveLength(14);
  expect(result.coverage).toMatchObject({outside_source_fill:15,groupedRoomCount:76,printedAreaCount:90,supplementaryBarrierCount:0});
  expect(result.coverage.approximateRegionCount).toBeGreaterThan(48);
  expect(result.coverage.highEvidenceWallCount).toBeLessThan(result.coverage.wallCount);
  // These source room annotations were previously suppressed by nearby apartment summaries.
  // Verify the nine audited additions as actual next-line source observations, not summary values.
  const livingAreas=result.rooms.filter(r=>r.name.startsWith("Wo.")).map(r=>r.geometry.printedArea?.value);
  for(const value of [27.32,36.28,24.93,28.58,37.67,24.99])expect(livingAreas).toContain(value);
  expect(livingAreas.filter(v=>v===27.32)).toHaveLength(2);
  for(const value of [4.49,5.02])expect(result.rooms.filter(r=>r.name==="Diele").map(r=>r.geometry.printedArea?.value)).toContain(value);
  expect(result.rooms.filter(r=>r.name==="Balkon"&&!r.geometry.printedArea)).toHaveLength(1);
  expect(result.assemblies.flatMap(a=>a.geometry.sourceFootprintKeys)).toHaveLength(geometry.candidates.length);
  const walls=result.assemblies.filter(a=>a.geometry.quality==="draft_wall");
  expect(walls.length).toBeGreaterThan(0);
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
  console.info("page1",{polygons:result.coverage.approximateRegionCount,anchors:result.coverage.unresolvedRegionCount});
  expect(oversized.every(r=>r.geometry.quality==="anchor")).toBe(true);
  expect(result.coverage.approximateRegionCount).toBeGreaterThanOrEqual(25);
  expect(Math.max(...result.rooms.flatMap(room=>room.geometry.polygon?[room.geometry.planRegion.width*room.geometry.planRegion.height]:[]))).toBeLessThan(.08);
});
