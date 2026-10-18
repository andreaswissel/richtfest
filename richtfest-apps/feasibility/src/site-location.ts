import { Router, type Request } from "express";
import { z } from "zod";
import { ok } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { features } from "./berlin-site-context";
export const mapLocationSchema = z.object({ mapOrigin:z.tuple([z.number().min(350000).max(430000),z.number().min(5780000).max(5860000)]), mapLabel:z.string().trim().min(1).max(300) });
export async function resolveAssessmentLocation(d:AppDeps,id:string,body:unknown,signal:AbortSignal) {
  const selected=mapLocationSchema.safeParse(body);
  if(selected.success) return {address:selected.data.mapLabel,origin:selected.data.mapOrigin,sources:[{label:"User-selected map position; verify parcel identity",url:"https://gdi.berlin.de/"}]};
  if (body && typeof body==="object" && "mapOrigin" in body) mapLocationSchema.parse(body);
  if(!d.resolveBerlinSite) throw Object.assign(new Error("Berlin address lookup unavailable"),{status:503});
  return d.resolveBerlinSite(id,signal);
}
export function createSiteLocationRouter(getDeps:(req:Request)=>AppDeps) {
  const router=Router();
  router.get("/projects/:projectId/site-locations",async(req,res,next)=>{try{
    const d=getDeps(req);d.requirePermission("projects:read");const id=z.string().uuid().parse(req.params.projectId);
    const project=await d.project(id);if(!project)throw Object.assign(new Error("Project not found"),{status:404});
    const match=project.address?.match(/^(.+?)\s+(\d+)\s*([a-z]?)(?:\s*,|\s|$)/i);
    if(!match)throw Object.assign(new Error("Save a complete street and house number in project details"),{status:422});
    const quote=(s:string)=>`'${s.replaceAll("'","''")}'`;
    const url=new URL("https://gdi.berlin.de/services/wfs/adressen_berlin");
    url.search=new URLSearchParams({service:"WFS",version:"2.0.0",request:"GetFeature",typeNames:"adressen_berlin:adressen_berlin",outputFormat:"application/json",srsName:"EPSG:25833",CQL_FILTER:`str_name ILIKE ${quote(match[1]!.replace(/ß|ss/gi,"%"))} AND hnr=${Number(match[2])}`,count:"100"}).toString();
    const normal=(s:unknown)=>String(s??"").trim().toLowerCase().replaceAll("ß","ss");
    const candidates=(await features(url.href,AbortSignal.timeout(15000))).filter(f=>normal(f.properties.str_name)===normal(match[1])&&Number(f.properties.hnr)===Number(match[2])).flatMap(f=>{
      const point=mapLocationSchema.shape.mapOrigin.safeParse(f.geometry?.coordinates);if(f.geometry?.type!=="Point"||!point.success)return[];
      const p=f.properties;return[{id:String(p.adressid??f.id),label:`${p.str_name} ${p.hnr}${p.hnr_zusatz??""}, ${p.plz} Berlin`,origin:point.data,exactMatch:normal(p.hnr_zusatz)===normal(match[3])&&/\bBerlin\b/i.test(project.address??"")&&(!(project.address??"").match(/\b\d{5}\b/)||String(p.plz)===(project.address??"").match(/\b\d{5}\b/)?.[0]),sourceUrl:url.href}];
    });
    res.json(ok({requestedAddress:project.address,candidates,retrievedAt:new Date().toISOString()}));
  }catch(e){next(e);}});
  return router;
}
