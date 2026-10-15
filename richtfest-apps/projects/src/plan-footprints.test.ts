import { expect,test } from "bun:test";
import { constructionFootprints,multiplyPlanTransform } from "./plan-footprints";
const codes={save:1,restore:2,transform:3,beginMarkedContentProps:4,endMarkedContent:5,constructPath:6,fill:7,stroke:8,eoClip:9};
const viewport={transform:[1,0,0,-1,0,200],width:200,height:200};
const polygon=[0,0,0,1,10,0,1,10,5,1,0,5,4];
test("native construction polygons respect graphics transforms, layer scope and dedupe",()=>{
  const ops={fnArray:[4,1,3,6,6,2,5,4,6],argsArray:[["OC",{type:"OCG",id:"construction"}],[],[2,0,0,2,20,30],[7,[polygon]],[7,[polygon]],[],[],["OC",{type:"OCG",id:"rooms"}],[7,[polygon]]]};
  const result=constructionFootprints(ops,codes,new Map([["construction","Grundriss Konstruktion"],["rooms","Räume"]]),viewport);
  expect(result.constructionFilledPaths).toBe(2);expect(result.candidates).toHaveLength(1);expect(result.omittedDuplicate).toBe(1);
  expect(result.candidates[0]).toMatchObject({entityType:"element",layerId:"construction",geometry:{quality:"footprint",planRegion:{x:.1,y:.8,width:.1}}});
  expect(result.candidates[0].geometry.planRegion.height).toBeCloseTo(.05);
  expect(result.candidates[0].geometry.polygon).toHaveLength(4);
  expect(multiplyPlanTransform([1,0,0,1,10,20],[2,0,0,3,4,5])).toEqual([2,0,0,3,14,25]);
});
test("open paths, curves, compound fills, specks and non-construction layers are not geometry claims",()=>{
  const inputs=[[0,0,0,1,10,0,1,10,10],[0,0,0,2,1,2,3,4,5,6,4],[...polygon,...polygon],[0,0,0,1,.01,0,1,.01,.01,1,0,.01,4]];
  const result=constructionFootprints({fnArray:[4,...inputs.map(()=>6)],argsArray:[["OC",{type:"OCG",id:"c"}],...inputs.map(p=>[7,[p]])]},codes,new Map([["c","Konstruktion"]]),viewport);
  expect(result.candidates).toHaveLength(0);expect(result.omittedUnsupported).toBe(3);expect(result.omittedSmall).toBe(1);
});
