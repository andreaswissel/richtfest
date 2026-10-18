import {describe,test,expect} from "bun:test";
import {proposeFootprint,suggestedStaffelShare,proposeStaffel,createEmptySiteGeometryInput,calculateSiteGeometry,createDefaultSetbacks,geometryArea,validateGeometry,generateMassingCandidates,classifyBerlinStorey,deriveBerlinSetback,berlinSetbackArea,checkSetbackAreas,intersectGeometry,affineFromControlPoints,transformPlanPoint,type GeometryEvidence,type GeometryMultiPolygon,type BuildingGeometry,type SiteGeometryInput} from "./site-geometry";
const X=392000,Y=5820000;
const rect=(x:number,y:number,w:number,h:number):GeometryMultiPolygon=>[[[[X+x,Y+y],[X+x+w,Y+y],[X+x+w,Y+y+h],[X+x,Y+y+h],[X+x,Y+y]]]];
const ev=(geometry:GeometryMultiPolygon,id="p"):GeometryEvidence=>({id,label:id,geometry,source:"Synthetic test survey",sourceDate:"2026-10-19",reviewed:true});
function fixture():SiteGeometryInput{const p=ev(rect(0,0,20,20));return {...createEmptySiteGeometryInput(),parcel:p,envelope:ev(rect(0,0,20,20),"envelope"),exclusionsReviewed:true,setbacks:createDefaultSetbacks(p,0).map(e=>({...e,source:"Reviewed test boundary",sourceDate:"2026-10-19",reviewed:true}))};}
const building=(geometry:GeometryMultiPolygon,id="b"):BuildingGeometry=>({id,label:id,footprint:ev(geometry,id),fullStoreys:3,storeyHeight:3,height:9,storeysSource:"Reviewed design",storeysReviewed:true,staffel:[]});
describe("versioned deterministic site geometry",()=>{
 test("clip envelope and exclusion, preserve holes",()=>{const input=fixture();input.envelope=ev(rect(0,0,10,20));input.exclusions=[ev(rect(2,2,2,2))];const r=calculateSiteGeometry(input);expect(r.status).toBe("reviewed");expect(r.parcelArea).toBe(400);expect(r.usableArea).toBe(196);expect(r.usableGeometry[0]!.length).toBe(2);});
 test("per-edge setbacks subtract actual geometry with conservative millimetre bound",()=>{const input=fixture();input.setbacks[0]!.distance=3;const r=calculateSiteGeometry(input);expect(r.usableArea).toBeLessThanOrEqual(340);expect(r.usableArea).toBeGreaterThan(339.98);expect(r.setbackApproximationMetres).toBe(.001);});
 test("setbacks support concave polygon without convex hull shortcut",()=>{const input=fixture();const g:GeometryMultiPolygon=[[[[X,Y],[X+20,Y],[X+20,Y+5],[X+5,Y+5],[X+5,Y+20],[X,Y+20],[X,Y]]]];input.parcel=ev(g);input.envelope=ev(g);input.setbacks=createDefaultSetbacks(input.parcel,1).map(e=>({...e,source:"review",sourceDate:"2026-10-19",reviewed:true}));const r=calculateSiteGeometry(input);expect(r.usableArea).toBeGreaterThan(0);expect(r.usableArea).toBeLessThan(175);expect(r.usableGeometry.length).toBeGreaterThan(0);});
 test("missing or unreviewed geometry cannot be reviewed",()=>{const input=fixture();input.setbacks=[];expect(calculateSiteGeometry(input).status).toBe("indicative");input.parcel=null;expect(calculateSiteGeometry(input).status).toBe("incomplete");});
 test("reject self intersection, unclosed rings, invalid hole",()=>{expect(validateGeometry([[[[0,0],[2,2],[0,2],[2,0],[0,0]]]])).toContain("self_intersection");expect(validateGeometry([[[[0,0],[2,0],[2,2],[0,2]]]])).toContain("ring_not_closed");const g=rect(0,0,5,5);g[0]!.push(rect(6,6,1,1)[0]![0]!);expect(validateGeometry(g)).toContain("invalid_hole");});
 test("real placement rejects outside and overlap; counts full and Staffel separately",()=>{const input=fixture();const b=building(rect(1,1,10,10));b.staffel=[{footprint:ev(rect(2,2,5,5),"s"),countable:false,height:3,areaAbove230:25,averageTopAboveTerrain:12,classificationReviewed:true}];input.buildings=[b];let r=calculateSiteGeometry(input);expect(r.buildings[0]!.validPlacement).toBe(true);expect(r.buildings[0]!.grossFloorArea).toBe(325);expect(r.buildings[0]!.countableFloorArea).toBe(300);input.buildings.push(building(rect(10,10,15,15),"b2"));r=calculateSiteGeometry(input);expect(r.buildings[0]!.overlapArea).toBe(1);expect(r.buildings[1]!.outsideArea).toBe(125);expect(r.buildings.every(b=>!b.validPlacement)).toBe(true);});
 test("Staffel cannot extend beyond floor below",()=>{const input=fixture();const b=building(rect(1,1,5,5));b.staffel=[{footprint:ev(rect(0,0,8,8)),countable:true,height:3,areaAbove230:null,averageTopAboveTerrain:null,classificationReviewed:false}];input.buildings=[b];const r=calculateSiteGeometry(input);expect(r.buildings[0]!.validPlacement).toBe(false);expect(r.issues.map(i=>i.code)).toContain("storey_classification_unresolved");});
 test("mandatory line requires facade length not single corner contact",()=>{const input=fixture();input.mandatoryLines=[{id:"line",label:"Baulinie",line:[[X,Y],[X+10,Y]],source:"plan",sourceDate:"2026-10-19",reviewed:true}];input.buildings=[building(rect(0,0,10,10))];expect(calculateSiteGeometry(input).issues.map(i=>i.code)).not.toContain("mandatory_line_unmet");input.buildings=[building(rect(10,0,5,5))];expect(calculateSiteGeometry(input).issues.map(i=>i.code)).toContain("mandatory_line_unmet");});
 test("three point affine alignment exact, rejects degenerate controls",()=>{const points=[{image:[0,0] as [number,number],site:[X,Y] as [number,number]},{image:[1,0] as [number,number],site:[X+20,Y] as [number,number]},{image:[0,1] as [number,number],site:[X,Y+10] as [number,number]}];const m=affineFromControlPoints(points)!;expect(transformPlanPoint([.5,.5],m)).toEqual([X+10,Y+5]);points[2]!.image=[.5,0];expect(affineFromControlPoints(points)).toBeNull();});
 test("Berlin full-storey boundary uses underlying floor and reviewed clear-height area",()=>{expect(classifyBerlinStorey({areaAbove230:200,referenceArea:300,averageTopAboveTerrain:1.41,reviewed:true})).toBe("full");expect(classifyBerlinStorey({areaAbove230:199.9,referenceArea:300,averageTopAboveTerrain:10,reviewed:true})).toBe("not_full");expect(classifyBerlinStorey({areaAbove230:300,referenceArea:300,averageTopAboveTerrain:1.4,reviewed:true})).toBe("not_full");expect(classifyBerlinStorey({areaAbove230:300,referenceArea:300,averageTopAboveTerrain:10,reviewed:false})).toBe("unresolved");expect(deriveBerlinSetback("standard",10)).toBe(4);expect(deriveBerlinSetback("boundary_exception",10)).toBeNull();});
 test("bounded generator returns three geometric unreviewed candidates within caps",()=>{const input=fixture();input.exclusions=[ev(rect(8,8,4,4))];const candidates=generateMassingCandidates(input,{grz:.5,gfz:1.5,maxFullStoreys:3,storeyHeight:3});expect(candidates).toHaveLength(3);for(const c of candidates){expect(c.building.footprint.reviewed).toBe(false);expect(c.metrics.validPlacement).toBe(true);expect(c.metrics.footprintArea).toBeLessThanOrEqual(200.001);expect(c.violations).toEqual([]);expect(geometryArea(c.building.footprint.geometry)).toBeCloseTo(c.metrics.footprintArea);}});
});

test("candidate Staffel allocation respects total GFZ before classification review",()=>{const cs=generateMassingCandidates(fixture(),{grz:.5,gfz:1.5,maxFullStoreys:3,storeyHeight:3,staffelRatio:.5});expect(cs).toHaveLength(3);for(const c of cs){expect(c.gfz).toBeLessThanOrEqual(1.500001);expect(c.building.staffel[0]!.classificationReviewed).toBe(false);}});
test("out of bounds candidate parameters return no misleading variants",()=>{expect(generateMassingCandidates(fixture(),{grz:.5,gfz:1.5,maxFullStoreys:201,storeyHeight:3})).toEqual([]);expect(generateMassingCandidates(fixture(),{grz:.5,gfz:1.5,maxFullStoreys:3,storeyHeight:3,staffelRatio:NaN})).toEqual([]);});
test("duplicate building identities cannot evade overlap validation",()=>{const input=fixture();input.buildings=[building(rect(0,0,5,5)),building(rect(0,0,5,5))];expect(calculateSiteGeometry(input).status).toBe("incomplete");});
test("multipart area and overlapping components validated",()=>{const separated=[...rect(0,0,2,2),...rect(4,4,2,2)];expect(geometryArea(separated)).toBe(8);expect(validateGeometry(separated)).toEqual([]);expect(validateGeometry([...rect(0,0,2,2),...rect(1,1,2,2)])).toContain("overlapping_polygons");});

test("seeded rectangle oracle validates different per-edge setbacks in metres",()=>{
 let seed=819;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32;};
 for(let i=0;i<30;i++){const w=10+random()*80,h=10+random()*80,distances=[random()*5,random()*5,random()*5,random()*5],input=fixture();input.parcel=ev(rect(0,0,w,h));input.envelope=ev(rect(0,0,w,h));input.setbacks=createDefaultSetbacks(input.parcel).map((e,j)=>({...e,distance:distances[j]!,source:"oracle",sourceDate:"2026-10-19",reviewed:true}));const result=calculateSiteGeometry(input),expected=(w-distances[1]!-distances[3]!)*(h-distances[0]!-distances[2]!);expect(result.usableArea).toBeLessThanOrEqual(expected+.0001);expect(Math.abs(result.usableArea-expected)).toBeLessThan((w+h)*.003);}
});
test("independent raster distance oracle covers reflex-corner setbacks",()=>{
 const input=fixture();input.parcel=ev([[[[X,Y],[X+20,Y],[X+20,Y+6],[X+6,Y+6],[X+6,Y+20],[X,Y+20],[X,Y]]]]);input.envelope=input.parcel;input.setbacks=createDefaultSetbacks(input.parcel,1).map(e=>({...e,source:"raster oracle",sourceDate:"2026-10-19",reviewed:true}));
 const edges=[[[0,0],[20,0]],[[20,0],[20,6]],[[20,6],[6,6]],[[6,6],[6,20]],[[6,20],[0,20]],[[0,20],[0,0]]];let cells=0;const step=.05;
 for(let x=step/2;x<20;x+=step)for(let y=step/2;y<20;y+=step){if(x>=6&&y>=6)continue;const distance=Math.min(...edges.map(([a,b])=>{const dx=b![0]!-a![0]!,dy=b![1]!-a![1]!,t=Math.max(0,Math.min(1,((x-a![0]!)*dx+(y-a![1]!)*dy)/(dx*dx+dy*dy)));return Math.hypot(x-a![0]!-t*dx,y-a![1]!-t*dy);}));if(distance>=1)cells++;}
 expect(Math.abs(calculateSiteGeometry(input).usableArea-cells*step*step)).toBeLessThan(.25);
});
test("touching buildings fit but internal courtyard cannot satisfy mandatory frontage",()=>{const input=fixture();input.buildings=[building(rect(0,0,5,5),"a"),building(rect(5,0,5,5),"b")];expect(calculateSiteGeometry(input).buildings.every(b=>b.validPlacement)).toBe(true);const g=rect(0,0,15,15);g[0]!.push(rect(5,5,5,5)[0]![0]!);input.buildings=[building(g)];input.mandatoryLines=[{id:"internal",label:"Baulinie",line:[[X+5,Y+5],[X+10,Y+5]],source:"review",sourceDate:"2026-10-19",reviewed:true}];const result=calculateSiteGeometry(input);expect(result.issues.map(i=>i.code)).toContain("mandatory_line_unmet");expect(result.buildings[0]!.validPlacement).toBe(false);});
test("outside-parcel mandatory line is invalid",()=>{const input=fixture();input.mandatoryLines=[{id:"external",label:"Baulinie",line:[[X-1,Y],[X-1,Y+5]],source:"review",sourceDate:"2026-10-19",reviewed:true}];expect(calculateSiteGeometry(input).issues.map(i=>i.code)).toContain("invalid_mandatory_line");});
test("known full Staffel cannot evade GF count through false toggle",()=>{const input=fixture();const b=building(rect(1,1,10,10));b.staffel=[{footprint:ev(rect(1,1,10,8)),countable:false,height:3,areaAbove230:80,averageTopAboveTerrain:12,classificationReviewed:true}];input.buildings=[b];const r=calculateSiteGeometry(input);expect(r.buildings[0]!.classifiedFullStoreys).toBe(4);expect(r.buildings[0]!.countableFloorArea).toBe(380);expect(r.status).toBe("indicative");});
test("editing full floors recomputes automatic setbacks and revokes height review",()=>{const input=fixture();input.buildings=[building(rect(7,7,5,5))];input.setbacks=input.setbacks.map(e=>({...e,profile:"standard",heightSource:"buildings",reviewedHeight:9}));const original=calculateSiteGeometry(input);expect(original.issues.map(i=>i.code)).not.toContain("setback_height_review_required");input.buildings[0]!.fullStoreys=5;const changed=calculateSiteGeometry(input);expect(changed.usableArea).toBeLessThan(original.usableArea);expect(changed.issues.map(i=>i.code)).toContain("setback_height_review_required");});
test("generator yields distinct alternatives on fully usable parcel and none when erased",()=>{const input=fixture();const cs=generateMassingCandidates(input,{grz:1,gfz:3,maxFullStoreys:3,storeyHeight:3});expect(cs.length).toBeGreaterThanOrEqual(2);expect(new Set(cs.map(c=>JSON.stringify(c.building.footprint.geometry))).size).toBe(cs.length);input.exclusions=[input.parcel!];expect(generateMassingCandidates(input,{grz:1,gfz:3,maxFullStoreys:3,storeyHeight:3})).toEqual([]);});
test("operation budget rejects dense topology before quadratic validation",()=>{const ring:Array<[number,number]>=Array.from({length:2400},(_,i)=>[X+10*Math.cos(i*Math.PI/1200),Y+10*Math.sin(i*Math.PI/1200)]);ring.push(ring[0]!);const g:GeometryMultiPolygon=[[ring]];expect(validateGeometry(g)).toEqual(["geometry_too_complex"]);const input=fixture();const smaller:GeometryMultiPolygon=[[ring.slice(0,1500).concat([ring[0]!])]];input.parcel=ev(smaller);input.envelope=ev(smaller);const r=calculateSiteGeometry(input);expect(r.status).toBe("incomplete");expect(r.issues.map(i=>i.code)).toContain("geometry_too_complex");expect(r.usableGeometry).toEqual([]);});
test("operation budget accounts for many curved setback cuts",()=>{const ring:Array<[number,number]>=Array.from({length:300},(_,i)=>[X+200*Math.cos(i*Math.PI/150),Y+200*Math.sin(i*Math.PI/150)]);ring.push(ring[0]!);const input=fixture();input.parcel=ev([[ring]]);input.envelope=input.parcel;input.setbacks=createDefaultSetbacks(input.parcel,100);const r=calculateSiteGeometry(input);expect(r.status).toBe("incomplete");expect(r.issues.map(i=>i.code)).toContain("geometry_too_complex");expect(generateMassingCandidates(input,{grz:.5,gfz:1.5,maxFullStoreys:3,storeyHeight:3})).toEqual([]);});

test("Abstandsflächen are wall rectangles of 0.4 H (min 3 m) and turn red only where they leave the parcel or overlap",()=>{
 // 10 × 6 m footprint, 12.5 m high: depth 5 m on every wall, corners excluded, for either winding.
 const footprint=rect(10,10,10,6),area=(g:GeometryMultiPolygon)=>Math.round(geometryArea(g)*100)/100;
 expect(area(berlinSetbackArea(footprint,5))).toBe(2*10*5+2*6*5);
 expect(area(berlinSetbackArea([[[...footprint[0]![0]!].reverse()]],5))).toBe(160);
 // L-shape: the inner corner walls face outwards too, and nothing lands on the building.
 const l:GeometryMultiPolygon=[[[[X,Y],[X+10,Y],[X+10,Y+4],[X+4,Y+4],[X+4,Y+10],[X,Y+10],[X,Y]]]];
 expect(geometryArea(berlinSetbackArea(l,3))).toBeGreaterThan(0);
 expect(geometryArea(intersectGeometry(berlinSetbackArea(l,3),l))).toBeLessThan(1e-6);
 const parcel=rect(0,0,40,30);
 // Low building in the middle: 3 m minimum fits.
 let [check]=checkSetbackAreas({parcel,buildings:[{id:"a",footprint,height:6}]});
 expect(check!.depth).toBe(3);expect(check!.ok).toBe(true);expect(check!.conflict).toEqual([]);
 // 30 m high: 12 m deep areas cross the west (x<0) and south (y<0) boundaries by 2 m each, over the wall width only.
 [check]=checkSetbackAreas({parcel,buildings:[{id:"a",footprint,height:30}]});
 expect(check!.depth).toBe(12);expect(check!.ok).toBe(false);
 expect(Math.round(check!.outsideParcel*100)/100).toBe(2*6+2*10);
 expect(Math.round(geometryArea(check!.clear)*100)/100).toBe(Math.round((2*10*12+2*6*12-32)*100)/100);
 // Two buildings whose 3 m areas overlap by 1 m between them: both are flagged.
 const checks=checkSetbackAreas({parcel,buildings:[{id:"a",footprint:rect(5,10,6,6),height:6},{id:"b",footprint:rect(16,10,6,6),height:6}]});
 expect(checks.map(c=>c.ok)).toEqual([false,false]);expect(Math.round(checks[0]!.overlap*100)/100).toBe(6);
 // A neighbour's area only matters where it meets ours.
 const neighbour=rect(-20,10,10,6);
 expect(checkSetbackAreas({parcel,buildings:[{id:"a",footprint,height:6}],neighbours:[{footprint:neighbour,area:berlinSetbackArea(neighbour,3)}]})[0]!.ok).toBe(true);
 const close=rect(25,10,6,6);
 expect(checkSetbackAreas({parcel,buildings:[{id:"a",footprint,height:6}],neighbours:[{footprint:close,area:berlinSetbackArea(close,3)}]})[0]!.ok).toBe(false);
});
test("a Staffelgeschoss gets its own setback area: recessed walls stay inside the main area, flush walls reach further",()=>{
 const parcel=rect(0,0,40,40),footprint=rect(10,10,20,20);
 // Whole building treated as 12 m: 0.4 × 12 = 4.8 m on every wall, 4 × 20 × 4.8 = 384 m².
 const [whole]=checkSetbackAreas({parcel,buildings:[{id:"a",footprint,height:12}]});
 expect(geometryArea(whole!.area)).toBeCloseTo(384,1);
 // 3 floors (9 m → 3.6 m: 4 × 20 × 3.6 = 288 m²) plus a Staffel recessed 4 m on all sides, top at 12 m: its 4.8 m reach only 0.8 m past the main walls.
 const [recessed]=checkSetbackAreas({parcel,buildings:[{id:"a",footprint,height:9,upper:[{footprint:rect(14,14,12,12),height:12}]}]});
 expect(recessed!.depth).toBeCloseTo(3.6);expect(recessed!.upperDepth).toBeCloseTo(4.8);
 expect(geometryArea(recessed!.area)).toBeCloseTo(288,1);
 // Staffel flush with the west and east walls over 12 m: those strips are 4.8 m deep, 1.2 m beyond the main area: 288 + 2 × 12 × 1.2.
 const [flush]=checkSetbackAreas({parcel,buildings:[{id:"a",footprint,height:9,upper:[{footprint:rect(10,14,20,12),height:12}]}]});
 expect(geometryArea(flush!.area)).toBeCloseTo(288+28.8,1);
});
test("Staffel proposal insets the footprint to at most two thirds of the floor below, at least 1.5 m",()=>{
 const s=proposeStaffel(rect(0,0,20,10));
 expect(geometryArea(s)).toBeLessThanOrEqual(200*2/3+1e-6);
 // A small inset that just meets 2/3: (20-2d)(10-2d) = 133.33 → d ≈ 0.88, so the 1.5 m minimum applies: 17 × 7 = 119.
 expect(geometryArea(s)).toBeCloseTo(17*7,1);
 // A wide plate needs more than 1.5 m: 40 × 40, (40-2d)² ≤ 1066.7 → d ≥ 3.67.
 const w=proposeStaffel(rect(0,0,40,40));expect(geometryArea(w)).toBeLessThanOrEqual(1600*2/3+1e-6);expect(geometryArea(w)).toBeGreaterThan(1600*2/3-5);
});
test("the suggested Staffel share stays just below the state's full-storey threshold, where equality already counts",()=>{
 const be=suggestedStaffelShare("BE")!;
 expect(be.rule).toBe("BauO Bln § 2 Abs. 12");
 expect(be.share).toBeLessThan(2/3);
 // At exactly 2/3 Berlin counts a Vollgeschoss; the proposal must not land there.
 expect(classifyBerlinStorey({areaAbove230:geometryArea(proposeStaffel(rect(0,0,40,40),be.share)),referenceArea:1600,averageTopAboveTerrain:10,reviewed:true})).toBe("not_full");
 expect(suggestedStaffelShare("XX")).toBeNull();
});

describe("base footprint proposal",()=>{
 const BE={factor:.4,minimum:3};
 const rot=(g:GeometryMultiPolygon,t:number):GeometryMultiPolygon=>g.map(p=>p.map(r=>r.map(([x,y])=>{const dx=x-X,dy=y-Y;return [X+dx*Math.cos(t)-dy*Math.sin(t),Y+dx*Math.sin(t)+dy*Math.cos(t)] as [number,number];})));
 test("insets the parcel by the Abstandsfläche of the proposed height on every open side",()=>{
  // 3 × 3 m = 9 m, 0.4 H = 3.6 m (above the 3 m minimum): (30 − 7.2) × (40 − 7.2) = 747.84 m².
  const r=proposeFootprint({parcel:rect(0,0,30,40),fullStoreys:3,storeyHeight:3,setback:BE})!;
  expect(r.depth).toBeCloseTo(3.6,6);expect(r.binding).toBe("setbacks");
  expect(r.candidates[0]!.strategy).toBe("setback_hull");
  expect(r.candidates[0]!.area).toBeLessThanOrEqual(747.84);expect(r.candidates[0]!.area).toBeGreaterThan(747.6);
  // One storey less: H = 6 m, the 3 m minimum applies: 24 × 34.
  expect(proposeFootprint({parcel:rect(0,0,30,40),fullStoreys:2,storeyHeight:3,setback:BE})!.regionArea).toBeCloseTo(24*34,0);
 });
 test("GRZ and GFZ cap the footprint and every candidate keeps its Abstandsflächen on the parcel",()=>{
  const grz=proposeFootprint({parcel:rect(0,0,30,40),fullStoreys:3,storeyHeight:3,setback:BE,grz:.4})!;
  expect(grz.binding).toBe("grz");expect(grz.target).toBeCloseTo(480,6);
  expect(grz.candidates.length).toBeGreaterThan(1);
  for(const c of grz.candidates){expect(c.area).toBeLessThanOrEqual(480+1e-6);expect(c.area).toBeGreaterThan(470);expect(checkSetbackAreas({parcel:rect(0,0,30,40),buildings:[{id:"c",footprint:c.footprint,height:9}]})[0]!.ok).toBe(true);}
  // GFZ 0.9 over 3 storeys allows 360 m² of footprint, tighter than GRZ 0.4; the official parcel area is the basis.
  const gfz=proposeFootprint({parcel:rect(0,0,30,40),fullStoreys:3,storeyHeight:3,setback:BE,grz:.4,gfz:.9,parcelArea:1200})!;
  expect(gfz.binding).toBe("gfz");expect(gfz.target).toBeCloseTo(360,6);expect(gfz.candidates[0]!.gfz).toBeLessThanOrEqual(.9+1e-9);
 });
 test("a boundary the building may stand on keeps no Abstandsfläche",()=>{
  // West edge built to (closed form): only 3.6 m off the east side, (30 − 3.6) × 32.8 = 865.92 m².
  const west:[[number,number],[number,number]]=[[X,Y+40],[X,Y]];
  const r=proposeFootprint({parcel:rect(0,0,30,40),fullStoreys:3,storeyHeight:3,setback:BE,boundaryEdges:[west]})!;
  expect(r.candidates[0]!.area).toBeGreaterThan(865.5);expect(r.candidates[0]!.area).toBeLessThanOrEqual(865.92);
  // The same footprint without the exemption fails the live check, so the exemption is what makes it valid.
  expect(checkSetbackAreas({parcel:rect(0,0,30,40),buildings:[{id:"c",footprint:r.candidates[0]!.footprint,height:9}]})[0]!.ok).toBe(false);
  expect(checkSetbackAreas({parcel:rect(0,0,30,40),buildings:[{id:"c",footprint:r.candidates[0]!.footprint,height:9}],exemptWalls:[west]})[0]!.ok).toBe(true);
 });
 test("a neighbour's Abstandsfläche reaching onto the parcel pushes the footprint away from it",()=>{
  // Neighbour 1 m east of the parcel, 12 m high: its 4.8 m area reaches 3.8 m in; ours must not overlap it, so the east inset is 3.8 + 3.6.
  const footprint=rect(31,5,10,30),neighbour={footprint,area:berlinSetbackArea(footprint,4.8)};
  const r=proposeFootprint({parcel:rect(0,0,30,40),fullStoreys:3,storeyHeight:3,setback:BE,neighbours:[neighbour]})!;
  // Beside the neighbour (the round corners of its area leave a little more room at its ends).
  const east=Math.max(...intersectGeometry(r.candidates[0]!.footprint,rect(0,10,30,20)).flat(2).map(p=>p[0]))-X;
  expect(east).toBeLessThanOrEqual(30-7.4+1e-3);expect(east).toBeGreaterThan(30-7.5);
  expect(checkSetbackAreas({parcel:rect(0,0,30,40),buildings:[{id:"c",footprint:r.candidates[0]!.footprint,height:9}],neighbours:[neighbour]})[0]!.ok).toBe(true);
 });
 test("a rotated parcel yields the same footprint area, and bands follow the plot axis",()=>{
  const r=proposeFootprint({parcel:rot(rect(0,0,30,40),Math.PI/5),fullStoreys:3,storeyHeight:3,setback:BE,grz:.4})!;
  const compact=r.candidates.find(c=>c.strategy==="compact")??r.candidates[0]!;
  expect(compact.area).toBeGreaterThan(470);expect(compact.area).toBeLessThanOrEqual(480+1e-6);
  // In the plot frame a band is a rectangle: its area fills its own bounding box.
  const band=r.candidates.find(c=>c.strategy.startsWith("band"))!;const local=rot(band.footprint,-Math.PI/5).flat(2);
  const w=Math.max(...local.map(p=>p[0]))-Math.min(...local.map(p=>p[0])),h=Math.max(...local.map(p=>p[1]))-Math.min(...local.map(p=>p[1]));
  expect(band.area/(w*h)).toBeGreaterThan(.99);
 });
 test("the state's setback rule sets the depth",()=>{
  expect(checkSetbackAreas({parcel:rect(0,0,30,40),buildings:[{id:"c",footprint:rect(3,3,24,34),height:15}]})[0]!.depth).toBeCloseTo(6,6);
  expect(checkSetbackAreas({parcel:rect(0,0,30,40),buildings:[{id:"c",footprint:rect(3,3,24,34),height:15}],setback:{factor:.2,minimum:3}})[0]!.ok).toBe(true);
 });
});
test("street land on the parcel leaves the GRZ/GFZ reference area; an ordinary exclusion does not",()=>{
 const input=fixture();
 // 20 × 20 parcel; a 2.5 m strip along the south edge is street land, a 4 × 4 easement is only an exclusion.
 input.exclusions=[{...ev(rect(0,0,20,2.5),"street"),nonBuildingLand:true},ev(rect(10,10,4,4),"easement")];
 const r=calculateSiteGeometry(input);
 expect(r.parcelArea).toBeCloseTo(400);expect(r.buildingLandArea).toBeCloseTo(350);
 expect(r.usableArea).toBeCloseTo(400-50-16);
 // Street land reaching beyond the parcel only counts where it overlaps it.
 input.exclusions=[{...ev(rect(-5,-5,30,7.5),"street"),nonBuildingLand:true}];
 expect(calculateSiteGeometry(input).buildingLandArea).toBeCloseTo(400-20*2.5);
});
