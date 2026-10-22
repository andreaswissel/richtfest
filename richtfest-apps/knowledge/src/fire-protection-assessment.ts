import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assessFirePlan } from "@richtfest/shared/fire-plan";
import type { AppDeps } from "./deps";
import { artifactInput, conflict, createArtifact, sources } from "./workspace";
import { stepHash } from "./run-steps";

// Content identity works in local development and the source-based Bun runtime,
// including uncommitted engine changes. Never pretend package 0.1 is a rule revision.
const engineDirectory = dirname(fileURLToPath(import.meta.resolve("@richtfest/shared/fire-plan")));
const engineVersion = "sha256:" + createHash("sha256").update(JSON.stringify(
  ["fire-protection.ts", "fire-protection-schema.ts", "fire-plan.ts"].map(name => ({ name,
    sha256: createHash("sha256").update(readFileSync(join(engineDirectory, name))).digest("hex") })))).digest("hex");

/** No numerical arguments, project selectors or approval flags are accepted from a model. */
export async function createFireProtectionAssessment(d: AppDeps, projectId: string, tx: any, runId: string, allowedSourceVersionIds?: string[]) {
  d.requirePermission("knowledge:write");
  d.requirePermission("projects:read");
  if (!d.fireProtectionSnapshot) throw conflict("Fire assessment is unavailable");
  const snapshot = await d.fireProtectionSnapshot(projectId);
  if (!snapshot.available) return { status: "blocked" as const, complete: false as const, reason: snapshot.reason };
  if (!snapshot.sourceVersionIds.length)
    return { status: "blocked" as const, complete: false as const, reason: "Saved fire inputs have no source evidence." };
  if (allowedSourceVersionIds && snapshot.sourceVersionIds.some(id => !allowedSourceVersionIds.includes(id)))
    return { status: "blocked" as const, complete: false as const, reason: "Saved fire inputs reference sources outside this execution's evidence scope." };
  await sources(d, projectId, snapshot.sourceVersionIds);
  const assessment = assessFirePlan(snapshot.plan);
  const receipt = { engine: "richtfest-fire-protection", engineVersion, modelId: snapshot.modelId, modelRevision: snapshot.revision,
    inputHash: stepHash(snapshot), outputHash: stepHash(assessment), hashMethod: "sha256-canonical-json", input: snapshot, output: assessment };
  const blockers = [...snapshot.blockers, ...assessment.gaps.map(gap => `${gap.id}: ${gap.outcome} — ${gap.note}`)];
  const content = ["# Brandschutz · Teilstand · Entwurf",
    "Deterministische Auswertung des gespeicherten Gebäudemodells. Keine Freigabe und kein vollständiger Brandschutznachweis. Eingaben, Geometrie und Anwendbarkeit sind fachlich zu prüfen.",
    `Modell ${snapshot.modelId}, Revision ${snapshot.revision}. Rechenwerk: ${engineVersion}.`,
    "## Quellen", ...snapshot.sourceVersionIds.map(id => `- [${id}]`),
    "## Offene Punkte", ...blockers.map(value => `- ${value.replace(/[\r\n]/g, " ")}`),
    assessment.concept ?? "Für das fehlende oder nicht unterstützte Bundesland wird kein Konzept erzeugt.",
    "## Rechenprotokoll (unverändert, maschinenlesbar)", "```json", JSON.stringify(receipt, null, 2), "```",
  ].join("\n\n");
  const created = await createArtifact(d, tx, artifactInput.parse({ projectId, title: "Brandschutz · Teilstand · Entwurf", type: "draft", content,
    sourceVersionIds: snapshot.sourceVersionIds }), runId);
  // Bounded model response; the immutable artifact retains the complete receipt.
  return { status: "draft_created" as const, complete: false as const, artifactId: created.artifact.id as string, revisionId: created.revision.id as string,
    sourceVersionIds: snapshot.sourceVersionIds,
    modelRevision: snapshot.revision, engineVersion, inputHash: receipt.inputHash, outputHash: receipt.outputHash,
    classification: assessment.classification, openItems: blockers.length, blockers: blockers.slice(0, 50),
    observations: assessment.observations.slice(0, 100), truncated: blockers.length > 50 || assessment.observations.length > 100,
    link: `/projects/${projectId}?panel=artifacts&artifact=${created.artifact.id}&revision=${created.revision.id}` };
}
export type FireProtectionToolResult = Awaited<ReturnType<typeof createFireProtectionAssessment>>;
