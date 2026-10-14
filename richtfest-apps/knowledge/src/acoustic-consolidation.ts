import { createHash } from "node:crypto";
import { Lexer } from "marked";
import { z } from "zod";
import {
  acousticConceptTemplateSchema, acousticSectionKeys, acousticEditorialCheckSchema,
  acousticConsolidationOutputSchema, type SourceReference, type SourceVisualRequest, type SourceVisual,
} from "@richtfest/shared";

type Template = z.infer<typeof acousticConceptTemplateSchema>;
type Candidate = z.infer<typeof acousticConsolidationOutputSchema>;
type Check = z.infer<typeof acousticEditorialCheckSchema>;
type Fragment = { id: string; section: string; content: string };
type Operation = { kind: "coverage" | "merge"; ids: string[]; candidate?: Candidate; check?: Check; feedback?: Check };
export type AcousticConsolidationState = {
  inputHash: string;
  fragments: Fragment[];
  plan: Operation[];
};
const algorithmVersion = 2;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const uuids = (value: unknown) => new Set((JSON.stringify(value).match(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi) ?? []).map(id => id.toLowerCase()));
const words = (value: string) => new Set(value.toLowerCase().replace(/\b[0-9a-f-]{36}\b/g, "").match(/[\p{L}]{5,}/gu) ?? []);
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(id => b.has(id));

/** Runs only on the accepted editorial template. Never mutates the author's draft or input. */
export async function consolidateAcousticConcept(input: {
  template: Template;
  sourceDirectory: SourceReference[];
  visualReads: { request: SourceVisualRequest; status: SourceVisual["status"]; receiptId: string }[];
  state?: AcousticConsolidationState;
  maxOutputTokens: number;
  inputByteBudget?: number;
  assertActive: () => Promise<unknown>;
  call: (context: Record<string, unknown>, validate: (output: unknown) => unknown) => Promise<unknown>;
  checkpoint: (state: AcousticConsolidationState) => Promise<void>;
}): Promise<Template> {
  await input.assertActive();
  const limit = Math.max(0, Math.min(4096, Math.floor(Math.min(input.maxOutputTokens, 6000) * 2 / 3)));
  const inputHash = createHash("sha256").update(JSON.stringify({ algorithmVersion, template: input.template,
    sourceDirectory: input.sourceDirectory, visualReads: input.visualReads, limit, inputByteBudget: input.inputByteBudget })).digest("hex");
  const fragments: Fragment[] = [];
  for (const section of acousticSectionKeys(input.template.id).filter(key => key !== "calculationAppendix")) {
    const content = input.template[section as keyof Template] as string;
    const blocks: string[] = [];
    for (const token of Lexer.lex(content)) {
      if (token.type === "space" && blocks.length) blocks[blocks.length - 1] += token.raw;
      else blocks.push(token.raw);
    }
    // Lossless or untouched: never normalize whitespace or split an indivisible block.
    for (const [index, raw] of (blocks.join("") === content ? blocks : [content]).entries())
      fragments.push({ id: `${section}:${index}`, section, content: raw });
  }
  let state = input.state;
  if (state?.inputHash !== inputHash) {
    const plan: Operation[] = [];
    const used = new Set<string>();
    const eligible = fragments.filter(f => bytes([f.content]) <= limit);
    // Every explicit cited inspection claim gets one reconciliation, including
    // claims with no receipt. Rendering is not evidence of semantic review.
    for (const f of eligible) {
      // Generic "unreviewed evidence" disclaimers are not inspection claims.
      if (uuids(f.content).size && /\b(?:unreadable|illegible|inspected|inspection|rendered|rendering|unavailable|budget_exhausted|coverage|checked|verified|lesbar|geprüft|geprueft|gesichtet|visuell)\b|(?:page|seite|blatt)\s+\d+[^\n.]{0,80}\b(?:unresolved|read|reviewed|offen)\b/i.test(f.content)) {
        plan.push({ kind: "coverage", ids: [f.id] }); used.add(f.id);
      }
    }
    for (const f of eligible) {
      if (used.has(f.id)) continue;
      const refs = uuids(f.content), terms = words(f.content);
      const candidates = eligible.filter(g => g.id !== f.id && !used.has(g.id) && bytes([f.content, g.content]) <= limit)
        .map(g => ({ g, shared: [...uuids(g.content)].filter(id => refs.has(id)).length,
          overlap: [...words(g.content)].filter(word => terms.has(word)).length }))
        .filter(c => terms.size >= 12 && words(c.g.content).size >= 12 && c.overlap >= 8 &&
          c.overlap / Math.max(terms.size, words(c.g.content).size) >= 0.5)
        .sort((a, b) => b.shared - a.shared || b.overlap - a.overlap || a.g.id.localeCompare(b.g.id));
      const next = candidates[0]?.g;
      if (next) { plan.push({ kind: "merge", ids: [f.id, next.id] }); used.add(f.id); used.add(next.id); }
    }
    state = { inputHash, fragments, plan };
  }
  const save = async () => { await input.assertActive(); await input.checkpoint(state!); await input.assertActive(); };
  // Plan is durable before any paid work, including a zero-operation plan.
  await save();
  const byId = new Map(fragments.map(f => [f.id, f]));
  const replacements = new Map<string, string>();
  for (const op of state.plan) {
    await input.assertActive();
    const original = op.ids.map(id => byId.get(id)!);
    if (original.some(f => !f)) throw new Error("Invalid consolidation plan");
    const references = uuids(original.map(f => f.content));
    const schema = acousticConsolidationOutputSchema.superRefine((candidate, ctx) => {
      const ids = candidate.replacements.map(r => r.id);
      if (!candidate.complete || ids.length !== op.ids.length || new Set(ids).size !== ids.length || ids.some(id => !op.ids.includes(id)))
        ctx.addIssue({ code: "custom", message: "Complete replacements must cover exactly the supplied fragment IDs." });
      const text = original.map(f => candidate.replacements.find(r => r.id === f.id)?.content ?? f.content);
      const next = uuids(text);
      if (bytes(candidate) > limit)
        ctx.addIssue({ code: "custom", message: "Replacement exceeds bounded checker reserve." });
      if (!sameSet(references, next))
        ctx.addIssue({ code: "custom", message: "Preserve exact UUID union; the directory cannot authorize new citations." });
      if (original.some(f => !text.some(t => t.trim()) && f.content.trim()))
        ctx.addIssue({ code: "custom", message: "Cannot delete all supplied evidence." });
      for (const section of new Set(original.map(f => f.section))) {
        const sectionText = fragments.filter(f => f.section === section).map(f => {
          const replacement = candidate.replacements.find(r => r.id === f.id);
          return replacement?.content ?? replacements.get(f.id) ?? f.content;
        }).join("");
        if (!sectionText.trim()) ctx.addIssue({ code: "custom", message: "Required sections cannot be emptied." });
      }
    });
    if (op.check && (!op.check.preserved || op.check.issues.length)) {
      op.feedback = op.check; delete op.check; delete op.candidate;
      await save();
    }
    const context: Record<string, unknown> = {
      documentTemplate: { id: input.template.id, version: 1 }, inputMode: "editorial-consolidation",
      operation: op.kind, original,
      instructions: "Consolidate only genuinely duplicated evidence; preserve every unique room, value, page, association, uncertainty and definition. Null retains exact original. Empty content removes only evidence retained in the other supplied member. Preserve original whitespace separators. Never resolve ambiguous Q aliases or introduce cross-references to absent content. Visual receipts are authoritative only for the exact page/crop/revision: missing receipt means unknown, available means rendering available, not semantic review; budget_exhausted means not inspected. Unavailable rendering does not establish illegibility; never infer unreadability from a rendering failure. Coverage operations reconcile only claims about inspection, not substantive source evidence.",
    };
    // Adjacent complete defining blocks are read-only and included only with headroom.
    const adjacent = fragments.filter((f, i) => !op.ids.includes(f.id) && original.some(o =>
      o.section === f.section && Math.abs(fragments.indexOf(o) - i) === 1));
    const definingContext: Fragment[] = [];
    for (const f of adjacent) {
      if (bytes([...original.map(o => o.content), ...definingContext.map(o => o.content), f.content]) <= limit)
        definingContext.push(f);
    }
    context.definingContext = definingContext;
    const contextRefs = uuids([...original, ...definingContext].map(f => f.content));
    context.sourceDirectory = input.sourceDirectory.filter(s => contextRefs.has(s.versionId.toLowerCase()));
    context.visualReads = input.visualReads.filter(v => contextRefs.has(v.request.versionId.toLowerCase()));
    const checkInstructions = `${context.instructions} Independently compare the original and replacement evidence semantically, including room/value/source/page associations and ambiguous aliases. Reject unsupported omissions, new claims, dangling references and incorrect inspection claims even when UUIDs and numbers are unchanged.`;
    if (input.inputByteBudget !== undefined && Math.max(
      bytes({ ...context, documentTask: "consolidation", feedback: op.feedback }),
      bytes({ ...context, documentTask: "consolidation_check", edited: "x".repeat(limit), instructions: checkInstructions }),
    ) > input.inputByteBudget) throw new Error("Consolidation writer/checker context exceeds input byte budget before paid writer.");
    if (!op.candidate) {
      await input.assertActive();
      const result = await input.call({ ...context, documentTask: "consolidation", feedback: op.feedback }, value => schema.parse(value));
      await input.assertActive();
      op.candidate = schema.parse(result);
      await save();
    }
    const candidate = schema.parse(op.candidate);
    if (!op.check && original.every(f => {
      const text = candidate.replacements.find(r => r.id === f.id)!.content;
      return text === null || text === f.content;
    })) {
      op.check = { preserved: true, issues: [] };
      await save();
    }
    if (!op.check) {
      await input.assertActive();
      const checkContext = { ...context, documentTask: "consolidation_check", edited: candidate,
        instructions: checkInstructions };
      if (input.inputByteBudget !== undefined && bytes(checkContext) > input.inputByteBudget)
        throw new Error("Consolidation checker exceeds input byte budget; candidate is saved but not applied.");
      const result = await input.call(checkContext, value => acousticEditorialCheckSchema.parse(value));
      await input.assertActive();
      op.check = acousticEditorialCheckSchema.parse(result);
      await save();
    }
    if (!op.check.preserved || op.check.issues.length)
      throw new Error("Consolidation preservation check rejected the candidate; explicit retry will revise only this operation using saved feedback.");
    for (const f of original) {
      const content = candidate.replacements.find(r => r.id === f.id)!.content;
      const separator = f.content.match(/\s*$/)![0];
      replacements.set(f.id, content === null || content === f.content ? f.content : content.trimEnd() + separator);
    }
  }
  await input.assertActive();
  const result = { ...input.template };
  for (const section of new Set(fragments.map(f => f.section))) {
    const content = fragments.filter(f => f.section === section).map(f => replacements.get(f.id) ?? f.content).join("");
    Object.assign(result, { [section]: content });
  }
  return result;
}
