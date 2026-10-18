import {expect,test} from 'bun:test';
import {toUtm} from '@richtfest/shared';
import {displayLonLat,referenceDimensions,discoverSiteReferences,boundaryClearance,referenceLabel} from './site-references';
const polygon=[[[[0,0],[20,0],[20,10],[0,10],[0,0]]]] as [number,number][][][];
test('display inverse projection and measured dimensions',()=>{const p=displayLonLat(toUtm(13.442,52.553,33));expect(p[0]).toBeCloseTo(13.442,7);expect(p[1]).toBeCloseTo(52.553,7);expect(referenceDimensions(polygon)).toEqual({area:200,depth:10,frontage:20});});
test('discovery computes parcel coverage without double-counting parts, never invents eave height',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=(async(url:unknown)=>{const u=String(url),isParcel=u.includes('alkis_flurstuecke'),isCad=u.includes('alkis_gebaeude');
  return Response.json({numberMatched:isCad?0:isParcel?1:2,features:isCad?[]:isParcel?[{id:'p',properties:{uuid:'p',afl:2000},geometry:{type:'Polygon',coordinates:[[[-10,-10],[40,-10],[40,30],[-10,30],[-10,-10]]]}}]:[1,2].map(i=>({id:`b${i}`,properties:{gml_id:`b${i}`,geschosse:'3',hoehe:10,grundrissaktualitaet:'2020-01-01'},geometry:{type:'MultiPolygon',coordinates:polygon}}))});}) as unknown as typeof fetch;
 try{const r=await discoverSiteReferences({address:'test',origin:[0,0],sources:[]},new AbortController().signal);expect(r.references.length).toBe(2);expect(r.references[0]?.metrics?.grz?.value).toBe(.1);expect(r.references[0]?.metrics?.gfz?.value).toBe(.3);expect(r.references[0]?.metrics?.eaveHeight?.value).toBeNull();expect(r.references[0]?.metrics?.gfz?.reviewed).toBe(false);}finally{globalThis.fetch=original;}
});

test('clearance includes concave parcel corners opposite a long building edge',()=>{
 const parcel=[[[[-5,-5],[25,-5],[25,15],[11,15],[10,11],[9,15],[-5,15],[-5,-5]]]] as [number,number][][][];
 expect(boundaryClearance(polygon,parcel)).toBe(1);
 const crossing=[[[[5,5],[15,5],[15,15],[5,15],[5,5]]]] as [number,number][][][];
 expect(boundaryClearance(polygon,crossing)).toBe(0);
});

test('reference geometry is rejected before quadratic work exceeds its budget',async()=>{
 const original=globalThis.fetch;
 const ring=Array.from({length:3000},(_,i)=>[Math.cos(i*2*Math.PI/3000),Math.sin(i*2*Math.PI/3000)]);ring.push(ring[0]!);
 globalThis.fetch=(async()=>Response.json({features:[{id:'large',properties:{},geometry:{type:'Polygon',coordinates:[ring]}}],numberMatched:1})) as unknown as typeof fetch;
 try{await expect(discoverSiteReferences({address:'test',origin:[0,0],sources:[]},new AbortController().signal)).rejects.toMatchObject({code:'reference_geometry_budget'});}finally{globalThis.fetch=original;}
});

test('skipped invalid building geometry cannot produce complete parcel ratios',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=(async(url:unknown)=>{
  const u=String(url),isParcel=u.includes('alkis_flurstuecke'),isCad=u.includes('alkis_gebaeude');
  return Response.json({numberMatched:isCad?0:isParcel?1:2,features:isCad?[]:isParcel?[{id:'p',properties:{uuid:'p',afl:2000},geometry:{type:'Polygon',coordinates:[[[-10,-10],[40,-10],[40,30],[-10,30],[-10,-10]]]}}]:[{id:'valid',properties:{geschosse:3,hoehe:10,grundrissaktualitaet:'2020-01-01'},geometry:{type:'MultiPolygon',coordinates:polygon}},{id:'invalid',properties:{},geometry:{type:'Polygon',coordinates:[[[1,1],[3,3],[1,3],[3,1],[1,1]]]}}]});
 }) as unknown as typeof fetch;
 try{const result=await discoverSiteReferences({address:'test',origin:[0,0],sources:[]},new AbortController().signal);expect(result.references).toHaveLength(1);expect(result.status[0]).toBe('unavailable');expect(result.references[0]?.metrics?.grz?.value).toBeNull();expect(result.references[0]?.metrics?.ridgeHeight?.sourceDate).toBeNull();}finally{globalThis.fetch=original;}
});
test('reference labels do not repeat a house number already in the street name',()=>{expect(referenceLabel('Giersstraße 20','20')).toBe('Giersstraße 20');expect(referenceLabel('Giersstraße','20')).toBe('Giersstraße 20');expect(referenceLabel('Giersstraße 120','20')).toBe('Giersstraße 120 20');expect(referenceLabel('Hauptstraße 4a','4A')).toBe('Hauptstraße 4a');});

test('GRZ 1 counts main buildings only; GRZ 2 adds garages and underground structures from ALKIS functions',async()=>{
 const original=globalThis.fetch;
 const rect=(x:number,y:number,w:number,h:number)=>({type:'Polygon',coordinates:[[[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]]]});
 const cadastral=[
  {id:'house',properties:{uuid:'house',bezeich:'AX_Gebaeude',gfk:1010,bezgfk:'Wohnhaus'},geometry:rect(0,0,20,10)},
  {id:'garage',properties:{uuid:'garage',bezeich:'AX_Gebaeude',gfk:2463,bezgfk:'Garage'},geometry:rect(25,0,5,10)},
  // Underground garage under half the house and beyond it: only the part outside the house adds to GRZ 2.
  {id:'tg',properties:{uuid:'tg',bezeich:'AX_Gebaeude',gfk:2465,ofl:1200},geometry:rect(10,-10,10,20)},
  {id:'part',properties:{uuid:'part',bezeich:'AX_Bauteil',bat:2100},geometry:rect(0,0,5,5)},
 ];
 globalThis.fetch=(async(url:unknown)=>{const u=String(url);
  if(u.includes('alkis_gebaeude'))return Response.json({numberMatched:cadastral.length,features:cadastral});
  if(u.includes('alkis_flurstuecke'))return Response.json({numberMatched:1,features:[{id:'p',properties:{uuid:'p',afl:2000},geometry:rect(-10,-20,50,40)}]});
  return Response.json({numberMatched:2,features:[{id:'b1',properties:{gml_id:'b1',geschosse:'3',hoehe:10},geometry:rect(0,0,20,10)},{id:'b2',properties:{gml_id:'b2',geschosse:'1',hoehe:3.2},geometry:rect(25,0,5,10)}]});}) as unknown as typeof fetch;
 try{
  const r=await discoverSiteReferences({address:'test',origin:[0,0],sources:[]},new AbortController().signal);
  // The garage is a Nebengebäude by its ALKIS function (3.2 m high, so not by height): § 6 (7) BauO Bln lets it stand in setback areas.
  expect(r.buildings.map(b=>[b.id,!!b.ancillary])).toEqual([['b1',false],['b2',true]]);
  const m=r.references[0]!.metrics!;
  expect(m.grz!.value).toBeCloseTo(200/2000,9);
  // House 200 + garage 50 + underground outside the house 100 = 350 m².
  expect(m.grz2!.value).toBeCloseTo(350/2000,9);
  expect(m.grz2!.source).toContain('lower bound');
  expect(m.grz2!.reviewed).toBe(false);
 }finally{globalThis.fetch=original;}
});
