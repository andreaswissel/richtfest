import { expect, test } from "bun:test";
import { planLabels, parsePlanBbox } from "./plan-extraction";
import { extractPlanFootprints, type PlanFillRegion, type PlanFootprint } from "./plan-footprints";
import { inferPlanTopology, printedAreaObservations } from "./plan-topology";
const rectangle=(x:number,y:number,w:number,h:number)=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
const fill:PlanFillRegion={sourceKey:"source-fill",layerId:"fill",layerName:"Füllflächen",fillRule:"evenodd",rings:[rectangle(.1,.1,.8,.8)]};
const word=(text:string,x:number,y:number)=>({text,x,y,width:.03,height:.01});
const footprint=(key:string,x:number,y:number,w:number,h:number):PlanFootprint=>({sourceKey:key,entityType:"element",name:key,layerId:"construction",layerName:"Konstruktion",quote:"Source polygon",geometry:{quality:"footprint",coordinateSpace:"normalized-page",polygon:rectangle(x,y,w,h),planRegion:{x,y,width:w,height:h},limitations:"Source footprint"}});

test("source-filled shared space yields explicit partitions, not walls or measured rooms",()=>{
  const labels=planLabels([word("Bad",.2,.3),word("Schlafen",.6,.3),word("Balkon",.95,.3)]);
  const result=inferPlanTopology(labels,[],[],100,[],0,[fill],1.5);
  expect(result.coverage.conflicting).toBe(2);expect(result.coverage.outside_source_fill).toBe(1);
  expect(result.rooms.slice(0,2).every(r=>r.geometry.quality==="approximate_partition")).toBe(true);
  expect(result.rooms[0].geometry.topology.competingSourceKeys).toEqual([result.rooms[1].sourceKey]);
  expect(result.rooms[2].geometry.quality).toBe("anchor");
  expect(result.coverage.relationships).toContain("Not established");
  expect(result.rooms[0]).not.toHaveProperty("area");
});
test("closed source barrier separates seeds; assemblies preserve original member polygons",()=>{
  const wall=footprint("wall",.49,.1,.02,.8),extension=footprint("extension",.51,.4,.08,.02);
  const result=inferPlanTopology(planLabels([word("Bad",.2,.3),word("Schlafen",.7,.3)]),[wall,extension],[],100,[],0,[fill]);
  expect(result.coverage.enclosed).toBe(2);
  expect(result.rooms.every(r=>r.geometry.quality==="enclosed_region")).toBe(true);
  expect(result.assemblies).toHaveLength(1);
  expect(result.assemblies[0].geometry.polygons).toEqual([wall.geometry.polygon,extension.geometry.polygon]);
});
test("even-odd source holes survive contours and are never filled as room area",()=>{
  const result=inferPlanTopology(planLabels([word("Bad",.2,.3)]),[],[],100,[],0,[{...fill,rings:[...fill.rings,rectangle(.5,.5,.1,.1)]}]);
  expect(result.rooms[0].geometry.holes).toHaveLength(1);
});
test("area observations prefer aligned next-line values and reject summary annotations",()=>{
  const labels=planLabels([word("Bad",.2,.2)]);
  const observations=printedAreaObservations(labels,[word("4.81",.2,.212),word("m²",.231,.212),word("Wfl.",.18,.225),word("52.30",.215,.225),word("m²",.246,.225)]);
  expect(observations.get(labels[0].sourceKey)).toMatchObject({value:4.81,status:"unreviewed",provenance:"inferred"});
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
  expect(result.coverage).toMatchObject({enclosed:3,conflicting:73,outside_source_fill:15,groupedRoomCount:76,approximateRegionCount:76,assemblyCount:72,printedAreaCount:90});
  expect(result.rooms.filter(r=>r.geometry.quality==="approximate_partition")).toHaveLength(73);
  // These source room annotations were previously suppressed by nearby apartment summaries.
  // Verify the nine audited additions as actual next-line source observations, not summary values.
  const livingAreas=result.rooms.filter(r=>r.name.startsWith("Wo.")).map(r=>r.geometry.printedArea?.value);
  for(const value of [27.32,36.28,24.93,28.58,37.67,24.99])expect(livingAreas).toContain(value);
  expect(livingAreas.filter(v=>v===27.32)).toHaveLength(2);
  for(const value of [4.49,5.02])expect(result.rooms.filter(r=>r.name==="Diele").map(r=>r.geometry.printedArea?.value)).toContain(value);
  expect(result.rooms.filter(r=>r.name==="Balkon"&&!r.geometry.printedArea)).toHaveLength(1);
  expect(result.assemblies.flatMap(a=>a.geometry.sourceFootprintKeys)).toHaveLength(235);
  for(const room of result.rooms) for(const point of room.geometry.polygon??[])expect(point.x>=0&&point.x<=1&&point.y>=0&&point.y<=1).toBe(true);
});
