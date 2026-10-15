import { expect, test } from "bun:test";
import { parsePlanBbox, parsePlanTsv, planLabels } from "./plan-extraction";

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
