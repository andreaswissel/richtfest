import { expect,test } from "bun:test";
import { alternativeConstructionLayer,constructionFootprints,multiplyPlanTransform } from "./plan-footprints";
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
test("fills close implicitly, curves flatten, compound fills keep rings; specks and other layers are not geometry",()=>{
  const open=[0,0,0,1,10,0,1,10,10],curve=[0,0,10,2,5,15,10,15,10,10,1,10,0,1,0,0,4],compound=[...polygon,0,20,20,1,30,20,1,30,30,1,20,30,4];
  const speck=[0,0,0,1,.01,0,1,.01,.01,1,0,.01,4];
  const ops={fnArray:[4,6,6,6,6,5,4,6],argsArray:[["OC",{type:"OCG",id:"c"}],[7,[open]],[7,[curve]],[7,[compound]],[7,[speck]],[],["OC",{type:"OCG",id:"text"}],[7,[polygon]]]};
  const result=constructionFootprints(ops,codes,new Map([["c","Konstruktion"],["text","Beschriftung"]]),viewport);
  expect(result.candidates).toHaveLength(3);expect(result.omittedSmall).toBe(1);
  expect(result.candidates[0].geometry.polygon).toHaveLength(3);
  expect(result.candidates[1].geometry).toMatchObject({curvesFlattened:true});
  expect(result.candidates[1].geometry.polygon.length).toBeGreaterThan(8);
  expect(result.candidates[2].geometry.rings).toHaveLength(2);
  expect(result.candidates[2].geometry.planRegion.height).toBeCloseTo(.15);
});
test("existing/demolition and hidden layers never become primary barriers",()=>{
  const ops={fnArray:[4,6,5,4,6,5],argsArray:[["OC",{type:"OCG",id:"existing"}],[7,[polygon]],[],["OC",{type:"OCG",id:"hidden"}],[7,[polygon]],[]]};
  const layers=new Map([["existing","Konstruktion Bestand"],["hidden","Konstruktion"]]);
  const primary=constructionFootprints(ops,codes,layers,viewport,undefined,undefined,new Set(["hidden"]));
  expect(primary.candidates).toHaveLength(0);expect(primary.omittedHiddenLayer).toBe(1);
  expect(constructionFootprints(ops,codes,layers,viewport,alternativeConstructionLayer,null).candidates.map(c=>c.layerId)).toEqual(["existing"]);
});
test("a stroked quarter-circle arc is recorded as door-swing evidence with its hinge",()=>{
  const k=.5523,arc=[0,100,100,1,100,110,0,100,110,2,100+10*k,110,110,100+10*k,110,100];
  const result=constructionFootprints({fnArray:[6],argsArray:[[8,[arc]]]},codes,new Map(),viewport);
  expect(result.doorSwings).toHaveLength(1);
  expect(result.doorSwings[0].hinge.x).toBeCloseTo(.5,3);expect(result.doorSwings[0].hinge.y).toBeCloseTo(.5,3);
  expect(result.doorSwings[0].radius).toBeCloseTo(.05,3);
  expect(result.candidates).toHaveLength(0);
});
test("repeated collinear dash strokes are not construction barriers; solid and irregular lines remain",()=>{
  const paths=[...Array.from({length:8},(_,i)=>[0,50,20+i*7,1,50,25+i*7]),
    [0,70,20,1,70,100], [0,90,20,1,90,25], [0,90,27,1,90,32], [0,90,40,1,90,45]];
  const result=constructionFootprints({fnArray:[4,...paths.map(()=>6),5],argsArray:[["OC",{type:"OCG",id:"c"}],...paths.map(p=>[8,[p]]),[]]},codes,new Map([["c","Konstruktion"]]),viewport);
  expect(result.barrierLines).toHaveLength(4);
  expect(result.barrierLines.some(line=>line.points.every(p=>p.x===.25))).toBe(false);
  expect(result.barrierLines.some(line=>line.points.every(p=>p.x===.35))).toBe(true);
});
