import {expect,test} from "bun:test";
import {mapLocationSchema,resolveAssessmentLocation} from "./site-location";
import type {AppDeps} from "./deps";

test("explicit map locations stay inside Berlin bounds and malformed selections never fall back",async()=>{
 let calls=0;
 const deps={resolveBerlinSite:async()=>{calls++;return {address:"saved",origin:[397136,5824134],sources:[]};}} as unknown as AppDeps;
 const signal=new AbortController().signal;
 const selected=await resolveAssessmentLocation(deps,"project",{mapOrigin:[395384,5820083],mapLabel:"Eldenaer Straße 60"},signal);
 expect(selected.address).toBe("Eldenaer Straße 60");expect(calls).toBe(0);
 await expect(resolveAssessmentLocation(deps,"project",{mapOrigin:[13.4,52.5],mapLabel:"wrong coordinate system"},signal)).rejects.toThrow();
 expect(calls).toBe(0);
 expect(mapLocationSchema.safeParse({mapOrigin:[395384,5820083],mapLabel:" "}).success).toBe(false);
 await resolveAssessmentLocation(deps,"project",{},signal);expect(calls).toBe(1);
});
