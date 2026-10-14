import { expect, test } from "bun:test";
import { consolidateAcousticConcept, type AcousticConsolidationState } from "./acoustic-consolidation";
import { acousticConceptTemplateSchema } from "@richtfest/shared";

const uuid = "00000000-0000-4000-8000-000000000001";
const sourceDirectory = [{ versionId: uuid, fileName: "Report.pdf", version: 1 }];
const oversized = "Indivisible " + "x".repeat(5000);
const evidence = "The bedroom facade assessment specifies acoustic insulation performance for nighttime sleeping occupancy under exterior traffic noise, with closed windows and mechanical ventilation maintaining the measured construction requirement.";
function template() {
  return acousticConceptTemplateSchema.parse({ id: "exterior-noise-concept", version: 1, language: "en",
    project: { name: "Test", number: null, client: null, designer: null, author: null, date: null },
    preliminaryRemarks: `${evidence} Bedroom A requires 35 dB, page 2 [source:${uuid}].\n\n${oversized}\n\n${evidence} The sleeping room A needs insulation of 35 dB (page 2); kitchen B needs 40 dB on page 3 [source:${uuid}].`,
    exteriorNoiseAssessment: "Assessment", plans: "Plans", components: "Components", planningLaw: "Law",
    sourcesAndRevisions: "Revisions", openIssues: "Issues", calculationAppendix: "Immutable appendix",
    attachments: [{ versionId: uuid, pageStart: 2, pageEnd: 3, label: "Original", section: "plans" }],
  });
}
type Context = Record<string, any>;
const unchanged = (c: Context) => ({ complete: true, replacements: c.original.map((f: any) => ({ id: f.id, content: null })) });
const passed = { preserved: true, issues: [] };
function harness() {
  let state: AcousticConsolidationState | undefined;
  const calls: Context[] = [];
  return {
    calls, get state() { return state; },
    run(call: (c: Context) => unknown | Promise<unknown>, extra = {}) {
      return consolidateAcousticConcept({ template: template(), sourceDirectory, visualReads: [], maxOutputTokens: 6000,
        state, assertActive: async () => {}, checkpoint: async s => { state = structuredClone(s); },
        call: async (c, validate) => { calls.push(c); return validate(await call(c)); }, ...extra });
    },
  };
}

test("cross-packet semantic dedup retains unique room/value/page and immutable data", async () => {
  const h = harness();
  const result = await h.run(c => c.documentTask === "consolidation_check" ? passed : {
    complete: true, replacements: [
      { id: c.original[0].id, content: `Bedroom A requires 35 dB, page 2; kitchen B needs 40 dB, page 3 [source:${uuid}].\n\n` },
      { id: c.original[1].id, content: "" },
    ],
  });
  expect(h.calls).toHaveLength(2);
  expect(result.preliminaryRemarks).toContain("kitchen B needs 40 dB, page 3");
  expect(result.preliminaryRemarks).not.toContain("sleeping room");
  expect(result.preliminaryRemarks).toContain(oversized);
  expect(result.project).toEqual(template().project);
  expect(result.attachments).toEqual(template().attachments);
  expect(result.calculationAppendix).toBe(template().calculationAppendix);
});

test("checker rejects changed associations despite unchanged UUIDs and numbers; retry saves feedback", async () => {
  const h = harness();
  await expect(h.run(c => c.documentTask === "consolidation_check"
    ? { preserved: false, issues: ["35 dB belongs to bedroom A, not kitchen B"] }
    : { complete: true, replacements: c.original.map((f: any, i: number) => ({ id: f.id,
      content: i ? "" : `Kitchen B requires 35 dB page 2; bedroom A 40 dB page 3 [source:${uuid}].` })) })).rejects.toThrow("preservation check");
  expect(h.state!.plan[0].check!.preserved).toBe(false);
  await h.run(c => {
    if (c.documentTask === "consolidation_check") return passed;
    expect(c.feedback.issues[0]).toContain("bedroom A");
    return unchanged(c);
  });
});

test("interrupted checker resumes exact persisted candidate without repeating writer", async () => {
  const h = harness();
  await expect(h.run(c => {
    if (c.documentTask === "consolidation_check") throw new Error("timeout");
    return { complete: true, replacements: c.original.map((f: any) => ({ id: f.id, content: f.content.replace("requires", "needs") })) };
  })).rejects.toThrow("timeout");
  const saved = structuredClone(h.state!.plan[0].candidate);
  await h.run(c => {
    expect(c.documentTask).toBe("consolidation_check");
    expect(c.edited).toEqual(saved);
    return passed;
  });
  expect(h.calls.map(c => c.documentTask)).toEqual(["consolidation", "consolidation_check", "consolidation_check"]);
});

test("conflicting Q1 definitions remain supplied verbatim for independent checker", async () => {
  const h = harness();
  const t = template();
  t.preliminaryRemarks = `${evidence} Q1 denotes bedroom A [source:${uuid}].\n\n${evidence} Q1 denotes kitchen B [source:${uuid}].`;
  await h.run(c => {
    if (c.documentTask === "consolidation_check") {
      expect(c.original.map((f: any) => f.content).join("")).toContain("Q1 denotes kitchen B");
      expect(c.instructions).toContain("ambiguous aliases");
      return passed;
    }
    return { complete: true, replacements: c.original.map((f: any) => ({ id: f.id, content: f.content.replace("denotes", "identifies") })) };
  }, { template: t });
});

test("coverage receipts precede merges and never turn unknown pages into unreadable pages", async () => {
  const h = harness();
  const visualReads = ["available", "budget_exhausted", "unavailable"].map((status, i) => ({
    request: { versionId: uuid, page: i + 1 }, status, receiptId: `receipt-${i}`,
  }));
  const t = template();
  t.preliminaryRemarks = `Page 4 remains unresolved [source:${uuid}].`;
  const result = await h.run(c => {
    expect(c.operation).toBe("coverage");
    expect(c.visualReads).toEqual(visualReads);
    expect(c.instructions).toContain("missing receipt means unknown");
    expect(c.instructions).toContain("not semantic review");
    expect(c.instructions).toContain("budget_exhausted means not inspected");
    return c.documentTask === "consolidation_check" ? passed : unchanged(c);
  }, { template: t, visualReads });
  expect(result.preliminaryRemarks).toBe(t.preliminaryRemarks);
});

test("invalid, missing, repeated IDs, incomplete outputs and changed UUID unions are rejected before checker", async () => {
  for (const variant of ["unknown", "missing", "repeat", "incomplete", "citation"]) {
    const h = harness();
    await expect(h.run(c => {
      const output = unchanged(c);
      if (variant === "unknown") output.replacements[0].id = "absent";
      if (variant === "missing") output.replacements.pop();
      if (variant === "repeat") output.replacements[1].id = output.replacements[0].id;
      if (variant === "incomplete") output.complete = false;
      if (variant === "citation") for (const r of output.replacements) r.content = "No evidence";
      return output;
    })).rejects.toThrow();
    expect(h.calls).toHaveLength(1);
  }
});

test("finite one-touch plan retains oversized blocks and completed operations do not replay", async () => {
  const h = harness();
  const call = (c: Context) => c.documentTask === "consolidation_check" ? passed : unchanged(c);
  const result = await h.run(call);
  const ids = h.state!.plan.flatMap(op => op.ids);
  expect(new Set(ids).size).toBe(ids.length);
  expect(h.calls.every(c => Buffer.byteLength(JSON.stringify(c.original.map((f: any) => f.content))) <= 4000)).toBe(true);
  expect(result).toEqual(template());
  await h.run(call);
  expect(h.calls).toHaveLength(1);
});

test("all cited coverage claims are reconciled even without receipts", async () => {
  const h = harness();
  const t = template();
  t.preliminaryRemarks = `Page 2 was inspected [source:${uuid}].\n\nPage 3 remains unresolved [source:${uuid}].\n\nPage 4 rendering is unavailable [source:${uuid}].`;
  expect(await h.run(unchanged, { template: t })).toEqual(t);
  expect(h.calls).toHaveLength(3);
  expect(h.calls.every(c => c.operation === "coverage")).toBe(true);
});

test("exact identity replacements checkpoint without semantic checker and keep original fragments", async () => {
  const h = harness();
  const result = await h.run(c => ({ complete: true,
    replacements: c.original.map((f: any) => ({ id: f.id, content: f.content })),
  }));
  expect(result).toEqual(template());
  expect(h.calls.map(c => c.documentTask)).toEqual(["consolidation"]);
  expect(h.state!.plan[0].check).toEqual(passed);
  expect(h.state!.fragments.filter(f => f.section === "preliminaryRemarks").map(f => f.content).join("")).toBe(template().preliminaryRemarks);
});

test("unrelated evidence and tiny generic headings do not pair merely by UUID", async () => {
  const h = harness();
  const t = template();
  t.preliminaryRemarks = `${evidence} [source:${uuid}].\n\nThe concrete foundation reinforcement requires independent structural analysis considering groundwater pressure, excavation sequencing, material durability, drainage capacity and construction tolerances [source:${uuid}].\n\n## Building evidence [source:${uuid}]\n\n## Building evidence [source:${uuid}]`;
  expect(await h.run(() => { throw new Error("No paid call expected"); }, { template: t })).toEqual(t);
  expect(h.state!.plan).toEqual([]);
});

test("replacement preserves exact original separators without writer supplied whitespace", async () => {
  const h = harness();
  const t = template();
  t.preliminaryRemarks = `${evidence} [source:${uuid}].\n \n\n${evidence} [source:${uuid}].\n\n`;
  const result = await h.run(c => c.documentTask === "consolidation_check" ? passed : {
    complete: true, replacements: c.original.map((f: any, i: number) => ({ id: f.id, content: i ? "" : `Retained evidence [source:${uuid}].` })),
  }, { template: t });
  expect(result.preliminaryRemarks).toBe(`Retained evidence [source:${uuid}].\n \n\n\n\n`);
});

test("insufficient writer or checker context fails explicitly before any paid call", async () => {
  for (const inputByteBudget of [1, 5000]) {
    const h = harness();
    await expect(h.run(unchanged, { inputByteBudget })).rejects.toThrow("before paid writer");
    expect(h.calls).toHaveLength(0);
    expect(h.state!.plan.length).toBeGreaterThan(0);
  }
});

test("cancellation after checkpoint prevents writer; cancellation after writer prevents checker", async () => {
  const h = harness();
  let active = true;
  const assertActive = async () => { if (!active) throw new Error("cancelled"); };
  await expect(h.run(unchanged, { assertActive, checkpoint: async () => { active = false; } })).rejects.toThrow("cancelled");
  expect(h.calls).toHaveLength(0);
  active = true;
  await expect(h.run(c => { active = false; return unchanged(c); }, { assertActive })).rejects.toThrow("cancelled");
  expect(h.calls).toHaveLength(1);
});

test("directory and visual receipts include defining context versions but no unrelated versions", async () => {
  const h = harness();
  const second = "00000000-0000-4000-8000-000000000002";
  const third = "00000000-0000-4000-8000-000000000003";
  const t = template();
  t.preliminaryRemarks = `Page 2 remains unresolved [source:${uuid}].\n\nDefinition [source:${second}].`;
  const directory = [uuid, second, third].map(versionId => ({ ...sourceDirectory[0], versionId }));
  const visualReads = directory.map(s => ({ request: { versionId: s.versionId, page: 2 }, status: "available", receiptId: s.versionId }));
  await h.run(c => {
    expect(c.sourceDirectory.map((s: any) => s.versionId)).toEqual([uuid, second]);
    expect(c.visualReads.map((s: any) => s.request.versionId)).toEqual([uuid, second]);
    return unchanged(c);
  }, { template: t, sourceDirectory: directory, visualReads });
});

test("patch editorial groups a sizable lossless report without identity check calls", async () => {
  const h = harness();
  const t = template();
  t.preliminaryRemarks = Array.from({ length: 127 }, (_, i) => `${i}: ${"Evidence wording ".repeat(190)}[source:${uuid}].\n\n`).join("");
  const result = await h.run(unchanged, { template: t, mode: "patch-editorial-v1" });
  expect(result).toEqual(t);
  expect(h.state!.mode).toBe("patch-editorial-v1");
  expect(h.calls).toHaveLength(32);
  expect(h.calls.every(c => c.documentTask === "consolidation" && Buffer.byteLength(JSON.stringify(c.original)) <= 16384)).toBe(true);
  expect(h.state!.plan.flatMap(op => op.ids)).toHaveLength(133);
  await h.run(() => { throw new Error("No replay"); }, { template: t });
  expect(h.calls).toHaveLength(32);
});

test("patch groups fit the minimum response envelope at lower configured output limits", async () => {
  for (const maxOutputTokens of [256, 1024]) {
    const h = harness(), t = template();
    t.preliminaryRemarks = Array.from({ length: 45 }, (_, i) => `Room ${i} remains unverified.\n\n`).join("");
    expect(await h.run(c => {
      const result = unchanged(c);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(Math.floor(maxOutputTokens * 2 / 3));
      return result;
    }, { template: t, mode: "patch-editorial-v1", maxOutputTokens })).toEqual(t);
    expect(h.calls.length).toBeGreaterThan(1);
    expect(h.state!.plan.flatMap(op => op.ids)).toHaveLength(51);
  }
});

test("changed patch gets a fresh check and rejected evidence is never returned", async () => {
  const h = harness();
  const t = template();
  await expect(h.run(c => c.documentTask === "consolidation_check"
    ? { preserved: false, issues: ["Changed association"] }
    : { complete: true, replacements: c.original.map((f: any, i: number) => ({ id: f.id,
      content: i ? null : f.content.replace("35 dB", "40 dB") })) },
  { template: t, mode: "patch-editorial-v1" })).rejects.toThrow("preservation check");
  expect(h.calls.map(c => c.documentTask)).toEqual(["consolidation", "consolidation_check"]);
  expect(t).toEqual(template());
  expect(await h.run(unchanged, { template: t })).toEqual(t);
  expect(h.calls).toHaveLength(3);
});

test("rejected patch repair retains exact diagnostics across interruption and rechecks changed evidence", async () => {
  const h = harness(), t = template();
  if (t.id !== "exterior-noise-concept") throw new Error("Expected exterior fixture");
  t.preliminaryRemarks = Array.from({ length: 18 }, (_, i) => `${i}: ${"Source evidence ".repeat(175)}[source:${uuid}].\n\n`).join("");
  t.exteriorNoiseAssessment = `The source reports page 1 display available; map features remain unchecked [source:${uuid}].`;
  t.plans = Array.from({ length: 9 }, (_, i) => `${i}: ${"Plan evidence ".repeat(175)}[source:${uuid}].\n\n`).join("");
  await h.run(unchanged, { template: t, mode: "patch-editorial-v1" });
  const saved = structuredClone(h.state!);
  const target = saved.plan.find(op => op.ids.includes("exteriorNoiseAssessment:0"))!;
  const accepted = structuredClone(saved.plan.filter(op => op !== target));
  const rejected = { complete: true, replacements: target.ids.map(id => ({ id,
    content: id === "exteriorNoiseAssessment:0" ? `Page 1 display availability is not established [source:${uuid}].` : null })) };
  const rejection = { preserved: false, issues: ["Missing receipts do not contradict reported display availability; retain attribution and unchecked map features."] };
  target.candidate = rejected;
  target.check = rejection;
  await expect(h.run(c => {
    expect(c.feedback).toEqual(rejection);
    expect(c.rejectedCandidate).toEqual(rejected);
    throw new Error("interrupted repair");
  }, { template: t, state: saved })).rejects.toThrow("interrupted repair");
  const repair = { complete: true, replacements: target.ids.map(id => ({ id,
    content: id === "exteriorNoiseAssessment:0" ? `Page 1 display was reported available by the source; map features remain unchecked [source:${uuid}].` : null })) };
  const before = h.calls.length;
  const result = await h.run(c => {
    expect(c.original.map((f: any) => f.id)).toEqual(target.ids);
    if (c.documentTask === "consolidation_check") {
      expect(c.edited).toEqual(repair);
      expect(c.feedback).toBeUndefined();
      expect(c.rejectedCandidate).toBeUndefined();
      return passed;
    }
    expect(c.feedback).toEqual(rejection);
    expect(c.rejectedCandidate).toEqual(rejected);
    return repair;
  }, { template: t });
  expect(h.calls.length - before).toBe(2);
  if (result.id !== "exterior-noise-concept") throw new Error("Expected exterior result");
  expect(result.exteriorNoiseAssessment).toBe(repair.replacements.find(r => r.content)!.content!);
  expect(result.preliminaryRemarks).toBe(t.preliminaryRemarks);
  expect(result.calculationAppendix).toBe(t.calculationAppendix);
  expect(h.state!.plan.filter(op => !op.ids.includes("exteriorNoiseAssessment:0"))).toEqual(accepted);
  expect(await h.run(() => { throw new Error("No replay"); }, { template: t })).toEqual(result);
});

test("patch subdivision resumes checked child and accepted non-prefix group", async () => {
  for (const truncation of [false, true]) {
    const h = harness();
    const t = template();
    t.preliminaryRemarks = Array.from({ length: 12 }, (_, i) => `${i}: ${"Evidence ".repeat(300)}[source:${uuid}].\n\n`).join("");
    await h.run(unchanged, { template: t, mode: "patch-editorial-v1" });
    const saved = structuredClone(h.state!);
    const rejected = { complete: true, replacements: saved.plan[0].ids.map(id => ({ id,
      content: saved.fragments.find(f => f.id === id)!.content.replace("Evidence", "Verified evidence") })) };
    const feedback = { preserved: false, issues: ["Evidence was not verified."] };
    saved.plan[0].candidate = rejected; saved.plan[0].check = feedback;
    const later = structuredClone(saved.plan.slice(1));
    let n = 0;
    await expect(h.run(c => {
      n++;
      if (c.documentTask === "consolidation") {
        expect(c.feedback).toEqual(feedback);
        expect(c.rejectedCandidate.replacements).toEqual(rejected.replacements.filter(r => c.original.some((f: any) => f.id === r.id)));
      }
      if (n === 1) {
        if (truncation) throw Object.assign(new Error("truncated"), { failureCategory: "validation", diagnostics: { finishReason: "length" } });
        return { ...unchanged(c), complete: false };
      }
      if (n === 2) return { complete: true, replacements: c.original.map((f: any, i: number) => ({ id: f.id,
        content: i ? null : f.content.replace("Evidence", "Source evidence") })) };
      if (c.documentTask === "consolidation_check") return passed;
      throw new Error("interrupted");
    }, { template: t, state: saved })).rejects.toThrow("interrupted");
    expect(h.state!.plan[0].children![0].check).toEqual(passed);
    expect(h.state!.plan.slice(1)).toEqual(later);
    const before = h.calls.length;
    const result = await h.run(unchanged, { template: t });
    expect(result.preliminaryRemarks).toContain("Source evidence");
    expect(h.calls.length - before).toBe(1);
  }
});

test("legacy checkpoint ignores requested patch mode and reuses paid work", async () => {
  const h = harness();
  await h.run(unchanged);
  const saved = structuredClone(h.state);
  expect(await h.run(() => { throw new Error("No replay"); }, { mode: "patch-editorial-v1" })).toEqual(template());
  expect(h.state).toEqual(saved);
  expect(h.calls).toHaveLength(1);
});

test("incomplete patch cannot disguise invalid evidence edits", async () => {
  const h = harness();
  await expect(h.run(c => ({ complete: false, replacements: c.original.map((f: any) => ({ id: f.id, content: "Unsupported" })) }),
    { mode: "patch-editorial-v1" })).rejects.toThrow("UUID union");
  expect(h.calls).toHaveLength(1);
  expect(h.state!.plan[0].children).toBeUndefined();
});

test("patch checker interruption reuses the exact candidate, and section deletion fails before check", async () => {
  const h = harness();
  await expect(h.run(c => {
    if (c.documentTask === "consolidation_check") throw new Error("timeout");
    return { complete: true, replacements: c.original.map((f: any, i: number) => ({ id: f.id,
      content: i ? null : f.content.replace("requires", "needs") })) };
  }, { mode: "patch-editorial-v1" })).rejects.toThrow("timeout");
  const saved = structuredClone(h.state!.plan[0].candidate);
  await h.run(c => {
    expect(c.documentTask).toBe("consolidation_check");
    expect(c.edited).toEqual(saved);
    return passed;
  });
  expect(h.calls.map(c => c.documentTask)).toEqual(["consolidation", "consolidation_check", "consolidation_check"]);
  const deletion = harness();
  await expect(deletion.run(c => ({ complete: true, replacements: c.original.map((f: any) => ({ id: f.id,
    content: f.section === "plans" ? "" : null })) }), { mode: "patch-editorial-v1" })).rejects.toThrow("Required sections");
  expect(deletion.calls).toHaveLength(1);
});
