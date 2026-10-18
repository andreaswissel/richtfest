import { describe, expect, test } from "bun:test";
import { evidenceRequestSchema, validateEvidenceOutput } from "./evidence";
const claim={key:"grz",value:.4,page:2,quote:"GRZ 0,4",reason:"Stated in use table; applicability requires review",evidenceKind:"text"};
const pages=[{page:2,text:"Use table: GRZ 0,4 and GFZ 1,2"}];
describe("source-linked planning proposals",()=>{
 test("accepts only quoted supplied page, with bounded compatible values",()=>{
  expect(validateEvidenceOutput({constraints:[claim],limitations:[]},pages,false).constraints[0]?.value).toBe(.4);
  expect(()=>validateEvidenceOutput({constraints:[{...claim,page:1}],limitations:[]},pages,false)).toThrow();
  expect(()=>validateEvidenceOutput({constraints:[{...claim,quote:"GRZ 0,8"}],limitations:[]},pages,false)).toThrow();
  expect(()=>validateEvidenceOutput({constraints:[{...claim,value:2}],limitations:[]},pages,false)).toThrow();
 });
 test("image evidence cannot silently substitute for missing text",()=>{
  const output={constraints:[{...claim,quote:"",evidenceKind:"image"}],limitations:[]};
  expect(()=>validateEvidenceOutput(output,pages,false)).toThrow();
  expect(validateEvidenceOutput(output,pages,true).constraints).toHaveLength(1);
 });
 test("textual planning facts retain exact supporting quote",()=>{
  const output={constraints:[],planningFacts:[{...claim,key:"buildingForm",value:"open building form"}],limitations:[]};
  expect(validateEvidenceOutput(output,pages,false).planningFacts[0]?.key).toBe("buildingForm");
  expect(()=>validateEvidenceOutput({...output,planningFacts:[{...output.planningFacts[0],quote:"absent"}]},pages,false)).toThrow();
 });
 test("limits page batches and requires explicit provider",()=>{
  const request={versionId:crypto.randomUUID(),pages:[2,2],provider:"openai"};
  expect(evidenceRequestSchema.parse(request).pages).toEqual([2]);
  expect(evidenceRequestSchema.safeParse({...request,pages:[1,2],visual:true}).success).toBe(false);
  expect(evidenceRequestSchema.safeParse({...request,provider:undefined}).success).toBe(false);
 });
});
