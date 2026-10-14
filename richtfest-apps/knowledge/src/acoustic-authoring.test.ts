import { expect, test } from "bun:test";
import { acousticSectionKeys, agentExecutionLimitsSchema } from "@richtfest/shared";
import { authorAcousticConcept, type AcousticDraft } from "./acoustic-authoring";
import type { AppDeps } from "./deps";

function harness() {
  let draft: AcousticDraft | undefined;
  const tasks: string[] = [];
  return {
    tasks, get draft() { return draft; },
    run(editor: (context: Record<string, any>) => unknown) {
      return authorAcousticConcept({ d: {} as AppDeps, projectId: "test", id: "exterior-noise-concept", goal: "Report",
        findings: [], sourceVersionIds: [], limits: agentExecutionLimitsSchema.parse({}), maxOutputTokens: 6000, maxParallel: 1, draft,
        assertActive: async () => {}, checkpoint: async saved => { draft = structuredClone(saved); },
        call: async (c, validate) => {
          tasks.push(String(c.documentTask));
          if (c.documentTask === "outline") return validate({ id: "exterior-noise-concept", title: "Acoustic report", language: "en",
            project: { name: "Test", number: null, client: null, designer: null, author: null, date: null }, attachments: [],
            sections: acousticSectionKeys("exterior-noise-concept").map(key => ({ key, sources: [] })) });
          if (c.documentTask === "section") return validate({ complete: true, content: `Evidence for ${c.section}.`, citations: [] });
          return validate(editor(c));
        },
      });
    },
  };
}

test("new authoring checkpoints explicit patch mode and skips full editorial rewrite/check", async () => {
  const h = harness();
  await h.run(c => {
    expect(c.documentTask).toBe("consolidation");
    expect(c.inputMode).toBe("patch-editorial-v1");
    expect(c.original).toHaveLength(7);
    return { complete: true, replacements: c.original.map((f: any) => ({ id: f.id, content: null })) };
  });
  expect(h.draft!.editorial!.mode).toBe("patch-editorial-v1");
  expect(h.tasks).toEqual(["outline", ...Array(7).fill("section"), "consolidation"]);
  const before = h.tasks.length;
  await h.run(() => { throw new Error("No replay"); });
  expect(h.tasks).toHaveLength(before);
});

test("unversioned editorial checkpoint remains legacy and resumes saved candidate after check timeout", async () => {
  const h = harness();
  await expect(h.run(() => { throw new Error("pause"); })).rejects.toThrow("pause");
  h.draft!.editorial = { inputHash: "legacy" };
  delete h.draft!.consolidation;
  await expect(h.run(c => {
    if (c.documentTask === "editorial_check") throw new Error("check timeout");
    expect(c.documentTask).toBe("editorial");
    return { complete: true, sections: c.sectionKeys.map((key: string) => ({ key, content: c.original[key] })) };
  })).rejects.toThrow("check timeout");
  const candidate = structuredClone(h.draft!.editorial!.candidate);
  const before = h.tasks.length;
  await h.run(c => {
    expect(c.documentTask).toBe("editorial_check");
    return { preserved: true, issues: [] };
  });
  expect(h.tasks.slice(before)).toEqual(["editorial_check"]);
  expect(h.draft!.editorial!.candidate).toEqual(candidate);
  expect(h.draft!.editorial!.mode).toBeUndefined();
  expect(h.draft!.consolidation!.mode).toBeUndefined();
});
