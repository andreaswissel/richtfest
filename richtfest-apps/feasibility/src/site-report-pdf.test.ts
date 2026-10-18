import { createEmptySiteGeometryInput } from "@richtfest/shared/site-geometry-model";
import { expect, test } from "bun:test";
import { createEmptySiteAssessmentInput, SITE_ASSESSMENT_CONSTRAINT_KEYS } from "@richtfest/shared";
import { createDefaultSetbacks } from "@richtfest/shared/site-geometry";
import { siteAssessmentReportPdf } from "./site-report-pdf";
import { writeFile } from "node:fs/promises";

test("exports saved assessment with actual geometry, source evidence and separate upside",async()=>{
 const input=createEmptySiteAssessmentInput();input.planningBasis="b_plan";
 const values=[1000,.4,1.2,400,3,100,0];SITE_ASSESSMENT_CONSTRAINT_KEYS.forEach((key,i)=>input.constraints[key]={value:values[i]!,source:"Synthetic PDF test evidence",sourceDate:"2026-10-18",kind:"assessment",reviewed:false});
 input.upside={maxFullStoreys:{...input.constraints.maxFullStoreys,value:4},note:"Hypothetical option only"};
 const g=createEmptySiteGeometryInput();g.parcel={id:"parcel",label:"Test parcel",geometry:[[[[392000,5820000],[392040,5820000],[392040,5820025],[392000,5820025],[392000,5820000]]]],source:"Synthetic coordinates",sourceDate:"2026-10-18",reviewed:true};
 g.envelope={...g.parcel,id:"envelope",label:"Test envelope"};g.setbacks=createDefaultSetbacks(g.parcel,3);g.exclusionsReviewed=true;
 g.buildings=[{id:"building",label:"A",footprint:{...g.parcel,id:"building-footprint",geometry:[[[[392008,5820007],[392025,5820007],[392025,5820018],[392008,5820018],[392008,5820007]]]]},fullStoreys:3,storeyHeight:3,height:null,storeysSource:"Test assumption",storeysReviewed:false,staffel:[]}];
 input.geometry=g;input.planningFacts={roofForm:{value:"Flat roof",source:"Plan page 2",sourceDate:null,kind:"assessment",reviewed:false}};
 input.references=[{id:"reference",label:"Synthetic reference",source:"Test source",note:"Not real project evidence"}];
 const pdf=await siteAssessmentReportPdf({project:{name:"PDF QA · Testgrundstück",address:"Berlin"},assessment:input,revision:7,updatedAt:"2026-10-18T12:00:00.000Z",language:"de"});
 expect(pdf.subarray(0,5).toString()).toBe("%PDF-");expect(pdf.length).toBeGreaterThan(10000);
 if(process.env.SITE_REPORT_QA_OUTPUT)await writeFile(process.env.SITE_REPORT_QA_OUTPUT,pdf);
 const empty=await siteAssessmentReportPdf({project:{name:"Empty",address:null},assessment:createEmptySiteAssessmentInput(),revision:1,updatedAt:"2026-10-18",language:"en"});expect(empty.length).toBeGreaterThan(5000);
});
