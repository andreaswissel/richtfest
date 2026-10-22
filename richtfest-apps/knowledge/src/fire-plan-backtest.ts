import { createHash } from "node:crypto";
import { z } from "zod";
import { assessFirePlan, firePlanSchema, validateFirePlan } from "@richtfest/shared/fire-plan";
import { buildingBacktestCandidateSchema } from "./building-backtest";

export const firePlanBacktestSchema = firePlanSchema.extend({
  version: z.literal(1), caseId: z.string().trim().min(1),
  sources: buildingBacktestCandidateSchema.shape.sources,
  runIds: buildingBacktestCandidateSchema.shape.runIds,
}).superRefine((value, ctx) => {
  validateFirePlan(value, ctx);
  for (const group of [value.building, ...value.storeys]) for (const locator of group.evidence) {
    if (!value.sources.some(source => source.id === locator.sourceId && source.format === (locator.kind === "page" ? "pdf" : "ifc")))
      ctx.addIssue({ code: "custom", message: "Evidence must reference a pinned source of the correct format" });
  }
});
export const fireBacktestHash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const fireBacktestJson = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** No reference answers are accepted here: execution and scoring are separate. */
export function runFirePlanBacktest(raw: unknown, engineVersion: string) {
  const input = firePlanBacktestSchema.parse(raw);
  const inputBytes = fireBacktestJson(input);
  const { concept, ...result } = assessFirePlan({ building: input.building, storeys: input.storeys });
  const assessmentBytes = fireBacktestJson({ version: 1, caseId: input.caseId, engineVersion, ...result });
  const receipt = { tool: "richtfest-fire-protection", version: engineVersion, inputSha256: fireBacktestHash(inputBytes), outputSha256: fireBacktestHash(assessmentBytes) };
  const artifacts = [{ id: "assessment", sha256: receipt.outputSha256 }];
  if (concept) artifacts.push({ id: "fire-concept", sha256: fireBacktestHash(concept) });
  const candidate = buildingBacktestCandidateSchema.parse({ version: 1, caseId: input.caseId, sources: input.sources, runIds: input.runIds, artifacts,
    observations: [...result.observations.map(item => ({ ...item, artifactId: "assessment", calculation: receipt, review: null })),
      { id: "fire-concept", value: null, unit: null, evidence: input.building.evidence,
        outcome: concept ? "complete" : input.building.input.state ? "unsupported" : "blocked",
        artifactId: concept ? "fire-concept" : null, calculation: receipt, review: null,
        note: "Draft generation only. Independent artifact-bound concept review is still required." }] });
  return { inputBytes, assessmentBytes, concept, candidate };
}
