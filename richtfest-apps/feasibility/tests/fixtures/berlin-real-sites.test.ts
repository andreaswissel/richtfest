import {expect,test} from "bun:test";
import evidence from "./berlin-real-sites.json";
import {calculateSiteGeometry,createEmptySiteGeometryInput,createDefaultSetbacks,geometryArea,validateGeometry,generateMassingCandidates,type GeometryMultiPolygon} from "@richtfest/shared/site-geometry";

for(const site of evidence.sites)test(`official ${site.key} polygon is valid and remains unreviewed`,()=>{
 const geometry=site.parcel.polygons as GeometryMultiPolygon;
 expect(validateGeometry(geometry)).toEqual([]);
 expect(Math.abs(geometryArea(geometry)-site.parcel.area)).toBeLessThan(site.parcel.area*.005);
 const input=createEmptySiteGeometryInput();input.parcel={id:site.parcel.id,label:site.parcel.label,geometry,source:site.parcel.sourceUrl,sourceDate:site.parcel.sourceDate,reviewed:false};
 const result=calculateSiteGeometry(input);
 expect(result.status).toBe("indicative");
 expect(result.issues.map(x=>x.code)).toContain("missing_envelope");
 expect(result.issues.map(x=>x.code)).toContain("unreviewed_geometry");
 // A test-only envelope and explicit artificial setbacks exercise clipping; never saved as legal inputs.
 input.envelope={...input.parcel,id:"test-envelope",source:"TEST ONLY: parcel as hypothetical envelope"};
 input.setbacks=createDefaultSetbacks(input.parcel,3);
 const clipped=calculateSiteGeometry(input);
 expect(clipped.usableArea).toBeGreaterThanOrEqual(0);
 expect(clipped.usableArea).toBeLessThan(result.parcelArea);
 expect(clipped.status).not.toBe("reviewed");
});
test("real Giers parcel contradicts the old derived area assumption",()=>{
 const site=evidence.sites.find(s=>s.key==="giers")!;
 expect(site.parcel.area).toBe(995);expect(site.parcel.containsAddress).toBe(true);
 expect(Math.abs(site.parcel.area-375/.38)).toBeGreaterThan(8);
});
test("1041m² Eldena candidate is never silently selected by street number or area",()=>{
 const site=evidence.sites.find(s=>s.key==="eldena-candidate")!;
 expect(site.parcel.area).toBe(1041);expect(site.parcel.containsAddress).toBe(false);
 expect(site.selectionStatus).toBe("nearby-area-match-candidate-unconfirmed");
 expect(site.addressContainingParcel?.area).toBe(2166);
 expect(site.parcel.id).not.toBe(site.addressContainingParcel?.id);
});
test("real jagged candidate supports bounded geometry generation only under explicit hypothetical constraints",()=>{
 const site=evidence.sites.find(s=>s.key==="eldena-candidate")!;const input=createEmptySiteGeometryInput();
 input.parcel={id:site.parcel.id,label:site.parcel.label,geometry:site.parcel.polygons as GeometryMultiPolygon,source:site.parcel.sourceUrl,sourceDate:site.parcel.sourceDate,reviewed:false};
 input.envelope={...input.parcel,id:"test-only-envelope",source:"TEST ONLY: no traced planning envelope"};input.setbacks=createDefaultSetbacks(input.parcel,0);
 const candidates=generateMassingCandidates(input,{grz:.5,gfz:1.6,maxFullStoreys:4,storeyHeight:3});
 expect(candidates.length).toBeGreaterThanOrEqual(2);
 for(const candidate of candidates){expect(candidate.metrics.validPlacement).toBe(true);expect(candidate.violations).toEqual([]);expect(candidate.building.footprint.reviewed).toBe(false);}
});
