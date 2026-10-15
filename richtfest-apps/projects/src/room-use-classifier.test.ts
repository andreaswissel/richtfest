import { expect, test } from "bun:test";
import { proposeRoomUses, reviewedCandidateGeometry, roomUseClassificationVersion, roomUseCriteria } from "./room-use-classifier";

const label=(sourceKey:string,name:string)=>({sourceKey,entityType:"room" as const,name,quote:name,geometry:{quality:"anchor"}});
const answer=(choice:keyof typeof roomUseCriteria)=>({type:"choice" as const,choice,confidence:0.9,
  probabilities:Object.fromEntries(Object.keys(roomUseCriteria).map(key=>[key,key===choice?0.9:0.01]))});

test("room-use classification deduplicates exact labels, is bounded and remains unreviewed metadata",async()=>{
  const labels=[label("a","Bad"),label("b","Bad"),...Array.from({length:70},(_,i)=>label(`x${i}`,`Room ${i}`))];
  let request:any;
  const result=await proposeRoomUses({tenantId:crypto.randomUUID(),actorId:crypto.randomUUID(),labels,signal:new AbortController().signal,
    executeDecision:async input=>{request=input;return {status:"completed",output:{model:"jev-1.13.0",
      answers:Object.fromEntries(Object.keys(input.questions).map(key=>[key,answer(key==="room_0"?"bathroom":"other_unknown")]))}};}});
  expect(Object.keys(request.questions)).toHaveLength(64);
  expect(request.state.version).toBe(roomUseClassificationVersion);
  expect(request.state.labels[0]).toEqual({id:"room_0",label:"Bad",exactSourceSnippet:"Bad"});
  expect(result.outcome).toBe("classified");
  expect((result.labels[0]!.geometry as any).roomUseProposal).toMatchObject({status:"unreviewed",provider:"typesafe",roomUse:"bathroom"});
  expect((result.labels[1]!.geometry as any).roomUseProposal.roomUse).toBe("bathroom");
  expect((result.labels.at(-1)!.geometry as any).roomUseProposal).toBeUndefined();
});

test("room-use classifier failure leaves deterministic candidates unchanged",async()=>{
  const labels=[label("a","WC")];
  const result=await proposeRoomUses({tenantId:crypto.randomUUID(),actorId:crypto.randomUUID(),labels,signal:new AbortController().signal,
    executeDecision:async()=>{throw new Error("provider unavailable");}});
  expect(result.outcome).toBe("fallback");
  expect(result.labels).toEqual(labels);
});

test("room-use classifier is optional",async()=>{
  const labels=[label("a","Flur")];
  const result=await proposeRoomUses({tenantId:crypto.randomUUID(),actorId:crypto.randomUUID(),labels,signal:new AbortController().signal});
  expect(result.outcome).toBe("unconfigured");
  expect(result.labels).toEqual(labels);
});

test("accepting candidate geometry does not implicitly approve inferred observations",()=>{
  expect(reviewedCandidateGeometry({quality:"enclosed_region",printedArea:{value:12},
    roomUseProposal:{status:"unreviewed",roomUse:"bathroom"}})).toEqual({quality:"enclosed_region"});
});
