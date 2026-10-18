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
