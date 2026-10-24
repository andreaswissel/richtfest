import { expect, test } from "bun:test";
import { extractPlanLabels, parsePlanBbox, parsePlanTsv, planLabels } from "./plan-extraction";
import { decodeSelectionMask, magicSelection, mergeOutlines } from "./plan-selection";
import { syntheticBayArea, syntheticPlanPdf, syntheticPlanRooms, type SyntheticPlanOptions } from "./test-fixtures/synthetic-plan";

test("PDF words use source dimensions and stable source keys, never invented room outlines",()=>{
  const words=parsePlanBbox('<doc><page width="400" height="200"><word xMin="100" yMin="50" xMax="140" yMax="60">Bad</word><word xMin="220" yMin="80" xMax="240" yMax="90">Beton</word></page></doc>');
  const labels=planLabels(words);expect(labels).toHaveLength(1);
  expect(labels[0]).toMatchObject({entityType:"room",name:"Bad",geometry:{quality:"anchor",planRegion:{x:.25,y:.25,width:.1,height:.05}}});
  expect(planLabels(words)[0].sourceKey).toBe(labels[0].sourceKey);
  expect(planLabels([{...words[0],x:.3}])[0].sourceKey).not.toBe(labels[0].sourceKey);
  expect(labels[0]).not.toHaveProperty("roomUse");expect(labels[0]).not.toHaveProperty("constructionState");
});
test("summary balcony mentions are excluded using nearby text, without plan coordinates",()=>{
  const word=(text:string,x:number,y:number)=>({text,x,y,width:.02,height:.01});
  expect(planLabels([word("Balkon",.12,.2),word("zzgl.",.095,.2),word("Balkon",.7,.8)]).map(x=>x.geometry.planRegion.x)).toEqual([.7]);
  expect(planLabels([word("büro@example.com",.2,.3),word("Beton",.3,.4),word("Bad",-1,.4)])).toHaveLength(0);
});
test("OCR TSV coordinates retain page dimensions and exclude low-confidence text",()=>{
  const header="level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n";
  const rows="1\t1\t0\t0\t0\t0\t0\t0\t1000\t500\t-1\t\n5\t1\t1\t1\t1\t1\t100\t50\t80\t20\t95\tFlur\n5\t1\t1\t1\t1\t2\t300\t50\t80\t20\t12\tBad";
  expect(planLabels(parsePlanTsv(header+rows))).toMatchObject([{name:"Flur",geometry:{planRegion:{x:.1,y:.1,width:.08,height:.04}}}]);
});
test("German room names, punctuation and decomposed umlauts are labels; drawing titles are not",()=>{
  const word=(text:string,x:number)=>({text,x,y:.5,width:.04,height:.01});
  const names=["Badezimmer","Gäste-WC","Wohn-/Essbereich","Arbeitszimmer","Waschküche","Bad:","Schlafzi.","Küche"];
  expect(names.map((name,i)=>planLabels([word(name,i*.1)]).length)).toEqual(names.map(()=>1));
  expect(planLabels([word("Bad:",.1)])[0].name).toBe("Bad");
  expect(planLabels([word("Beton",.1),word("Badenweiler",.2),word("Kindergarten",.3)])).toHaveLength(0);
  expect(planLabels([word("Grundriss",.1),word("Keller",.145)])).toHaveLength(0);
});
test("OCR labels carry their text source and confidence",()=>{
  const header="level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n";
  const words=parsePlanTsv(header+"1\t1\t0\t0\t0\t0\t0\t0\t1000\t500\t-1\t\n5\t1\t1\t1\t1\t1\t100\t50\t80\t20\t61\tFlur");
  expect(planLabels(words,"ocr")[0].geometry.textSource).toEqual({method:"ocr",confidence:61});
  expect(planLabels(words)[0].geometry.textSource).toEqual({method:"native_text",confidence:null});
});

const popplerAvailable=Bun.spawnSync(["which","pdftotext"]).exitCode===0;
const extract=async(options:SyntheticPlanOptions={}, extractionOptions: Parameters<typeof extractPlanLabels>[3]={})=>{
  const pdf=syntheticPlanPdf(options),result=await extractPlanLabels((async function*(){yield pdf;})(),1,new AbortController().signal,extractionOptions);
  const [width,height]=options.page??[1190.55,841.89],k=72/25.4*1000/(options.scale??100);
  const area=(g:any)=>g.polygon?(polygonArea(g.polygon)-(g.holes??[]).reduce((s:number,h:any)=>s+polygonArea(h),0))*width*height/k/k:null;
  const rooms=new Map(result.labels.map(l=>[l.name,{...l,area:area(l.geometry)}]));
  const connects=(a:string,b:string)=>(rooms.get(a)!.geometry as any).topology.openings.find((o:any)=>o.connectsTo===rooms.get(b)!.sourceKey);
  return {result,rooms,connects};
};
const polygonArea=(p:{x:number;y:number}[])=>Math.abs(p.reduce((s,a,i)=>{const b=p[(i+1)%p.length];return s+a.x*b.y-b.x*a.y;},0))/2;
test.skipIf(!popplerAvailable)("synthetic CAD plan: doors and windows close, L-shaped rooms are traced and connections recorded",async()=>{
  const {result,rooms,connects}=await extract();
  expect([...rooms.keys()].sort()).toEqual(["Bad","Flur","Küche","Schlafen","Wohnen"]);
  for(const room of syntheticPlanRooms){
    const traced=rooms.get(room.label)!;
    expect(traced.geometry).toMatchObject({quality:"enclosed_region",topology:{status:"enclosed"}});
    // Traced free space excludes half of each 12 cm partition, so it stays slightly below the printed area.
    expect(traced.area!/room.area).toBeGreaterThan(.88);expect(traced.area!/room.area).toBeLessThan(1.01);
  }
  expect((rooms.get("Wohnen")!.geometry as any).polygon).toHaveLength(6);
  expect((rooms.get("Flur")!.geometry as any).polygon).toHaveLength(6);
  for(const room of ["Wohnen","Küche","Bad","Schlafen"])expect(connects("Flur",room)).toMatchObject({kind:"jamb_pair"});
  expect(connects("Wohnen","Küche")).toBeUndefined();
  expect(result.topologyCoverage).toMatchObject({openingCount:11,doorSwingCount:5,doorSwingSupportedOpeningCount:5});
});
test.skipIf(!popplerAvailable)("physical area QC requires dimension chains or planner scale, and preserves conflicts instead of improving the score",async()=>{
  for(const options of [{}, {titleScale:null}]){
    const {result}=await extract(options);
    expect(result.labels).toHaveLength(5);
    expect(result.labels.every(room=>(room.geometry as any).printedScaleQc==null)).toBe(true);
  }
  for(const [options,extractionOptions,source] of [
    [{dimensionChains:true},{},"dimension_chains_and_title_block"],
    [{dimensionChains:true,scale:200,titleScale:100},{},"dimension_chains"],
    [{},{scaleDenominator:100},"planner"],
  ] as const){
    const {result,rooms}=await extract(options,extractionOptions);
    expect(result.scaleObservation?.source).toBe(source);
    for(const expected of syntheticPlanRooms){
      const room=rooms.get(expected.label)!,qc=(room.geometry as any).printedScaleQc;
      expect(qc).not.toBeNull();
      // Independent fixture dimensions, not the extracted scale, define these ranges.
      expect(qc.estimatedArea).toBeGreaterThan(expected.area*.88);
      expect(qc.estimatedArea).toBeLessThan(expected.area*1.01);
      expect(qc.printedArea).toBe(expected.area);
      expect(qc.toleranceM2).toBe(Math.max(.5,expected.area*.1));
      expect(qc.status).toBe(Math.abs(qc.estimatedArea-expected.area)>qc.toleranceM2?"conflict":"unreviewed");
    }
    expect(rooms.get("Schlafen")!.geometry).toMatchObject({quality:"enclosed_region",printedScaleQc:{status:"unreviewed"}});
  }
  const wrong=await extract({}, {scaleDenominator:200});
  const conflict=wrong.rooms.get("Schlafen")!;
  expect(conflict.geometry).toMatchObject({quality:"anchor",printedScaleQc:{status:"conflict",printedArea:27}});
  expect((conflict.geometry as any).printedScaleQc.estimatedArea).toBeGreaterThan(90);
  expect(conflict.geometry.polygon).toBeUndefined();
},60_000);
test.skipIf(!popplerAvailable)("synthetic CAD plan variants: corner door, curved bay, merged wall fill and other scales",async()=>{
  const corner=await extract({cornerDoor:true});
  expect(corner.connects("Wohnen","Küche")).toMatchObject({kind:"door_swing_jamb"});
  expect(corner.rooms.get("Küche")!.geometry).toMatchObject({quality:"enclosed_region"});
  const bay=await extract({curvedBay:true});
  expect(bay.rooms.get("Schlafen")!.area!/(27+syntheticBayArea)).toBeGreaterThan(.9);
  for(const options of [{mergedWalls:true},{scale:50,page:[1190.55,1683.78] as [number,number]},{scale:200,page:[841.89,595.28] as [number,number]}]){
    const {rooms}=await extract(options);
    expect([...rooms.values()].map(r=>r.geometry.quality)).toEqual(syntheticPlanRooms.map(()=>"enclosed_region"));
  }
});
test.skipIf(!popplerAvailable)("synthetic plan with stroked walls, segmented door arcs and furniture cut out of the floor fill",async()=>{
  const {result,rooms,connects}=await extract({strokedWalls:true});
  expect(result.topologyCoverage).toMatchObject({doorSwingCount:5});
  for(const room of syntheticPlanRooms){
    const traced=rooms.get(room.label)!;
    expect(traced.geometry).toMatchObject({quality:"enclosed_region",topology:{status:"enclosed"}});
    // Bed and table cut-outs (4.9 m² in Schlafen) belong to the room, not to a wall.
    expect(traced.area!/room.area).toBeGreaterThan(.9);expect(traced.area!/room.area).toBeLessThan(1.01);
  }
  for(const room of ["Wohnen","Bad","Schlafen"])expect(connects("Flur",room)).toMatchObject({kind:"door_swing_doorway"});
});
test.skipIf(!popplerAvailable)("double-leaf doors separate rooms without self-connections or losing their floor area",async()=>{
  const {rooms,connects}=await extract({strokedWalls:true,doubleLeafDoor:true});
  for(const expected of syntheticPlanRooms){
    const room=rooms.get(expected.label)!;
    expect(room.area!/expected.area).toBeGreaterThan(.9);
    expect(room.area!/expected.area).toBeLessThan(1.01);
    expect(room.geometry.topology.openings.some(o=>o.connectsTo===room.sourceKey)).toBe(false);
  }
  expect(connects("Flur","Wohnen")).toBeDefined();
  expect(connects("Wohnen","Flur")).toBeDefined();
});
test.skipIf(!popplerAvailable)("magic selection fills the clicked room from the stored barriers, and nothing outside the building",async()=>{
  const {result,rooms}=await extract({strokedWalls:true});
  const cells=decodeSelectionMask(result.selectionMask.data,result.selectionMask.gridSize);
  expect(result.pageScale.metresPerPageHeight).toBeGreaterThan(0);
  for(const room of syntheticPlanRooms){
    const label=rooms.get(room.label)!.geometry.labelRegion??rooms.get(room.label)!.geometry.planRegion;
    const picked=magicSelection(cells,result.selectionMask.gridSize,{x:label.x+label.width/2,y:label.y+label.height/2},result.pageScale);
    if(picked.status!=="found")throw new Error(`${room.label}: ${picked.status}`);
    const outline=picked.options[0];
    // Door leaves and furniture are not walls: the room comes back whole, with few editable anchors.
    expect(outline.areaM2!/room.area).toBeGreaterThan(.88);expect(outline.areaM2!/room.area).toBeLessThan(1.05);
    expect(outline.polygon.length).toBeLessThanOrEqual(14);
    expect(outline.polygon.every((p,i,ring)=>{const q=ring[(i+1)%ring.length];return p.x===q.x||p.y===q.y;})).toBe(true);
  }
  expect(magicSelection(cells,result.selectionMask.gridSize,{x:.02,y:.02},result.pageScale).status).toBe("not_enclosed");
});

test("merging rooms bridges the wall between them and nothing beyond the rooms' extent",()=>{
  // 12 m page, 1 cm cells: a 4×3 m room and a 2.76×2 m room behind a 24 cm wall.
  const rect=(x0:number,y0:number,x1:number,y1:number)=>({polygon:[{x:x0/12,y:y0/12},{x:x1/12,y:y0/12},{x:x1/12,y:y1/12},{x:x0/12,y:y1/12}]});
  const scale={pageAspectRatio:1,metresPerPageHeight:12};
  const merged=mergeOutlines([rect(1,1,5,4),rect(5.24,1,8,3)],scale)!;
  expect(merged.areaM2!).toBeCloseTo(4*3+.24*2+2.76*2,1);
  expect(merged.holes).toEqual([]);
  expect(mergeOutlines([rect(1,1,5,4),rect(6,1,8,3)],scale)).toBeNull();
});
