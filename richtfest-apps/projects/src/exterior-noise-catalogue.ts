import { Router, type Request } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { buildingEvidenceSchema, ok, type MassiveWallInput, type MassiveWallRw } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { modelForProject, touchRevision } from "./building-model-router";
import { readExteriorNoiseProof, writeSuggestion } from "./exterior-noise-proof";
import { buildingModels, buildingProperties, buildingPropertyVersions, buildingRevisions } from "./schema";

/**
 * Catalogue values for the exterior noise verification: the Rw of single-leaf
 * massive exterior walls from their construction, material, thickness and
 * density (DIN 4109-32 mass law, numbers from the server's norm pack). Values
 * are written as suggestions citing the pages their inputs came from.
 */

export type WallClass = Pick<MassiveWallInput, "material" | "form" | "perforated">;
export type WallClassification = WallClass | { reason: "not_massive" | "material_unknown" | "multi_leaf" };

/** Reads which mass law a wall follows from its construction and material text. Unclear walls get no class. */
export function classifyMassiveWall(construction: string | null, material: string | null): WallClassification {
  const text = material ?? "";
  if (construction === "drywall" || construction === "timber" || construction === "steel") return { reason: "not_massive" };
  // Insulated, ventilated or filled build-ups need their own catalogue corrections or approvals.
  if (/wdvs|wärmedämmverbund|waermedaemmverbund|vorsatzschale|vorhangfassade|hinterlüft|hinterlueft|zweischalig|kerndämm|kerndaemm|verfüll|verfuell|füllziegel|schalungsstein|schalungsziegel/i.test(text)) return { reason: "multi_leaf" };
  if (/porenbeton|gasbeton|ytong|hebel|\bPP\s?\d/i.test(text)) return { material: "aerated_concrete", form: "masonry", perforated: "none" };
  if (/leichtbeton|bims|blähton|blaehton|liapor|\bHbl\b|\bVbl\b/i.test(text))
    return { material: "lightweight_concrete", form: /stein|block|\bHbl\b|\bVbl\b/i.test(text) ? "masonry" : "concrete", perforated: /hohlblock|\bHbl\b|loch/i.test(text) ? "block" : "none" };
  if (/kalksand|\bKS\b|\bKSL\b|\bKS-L\b|\bKS\s?\d/i.test(text)) return /schlitz/i.test(text) ? { reason: "material_unknown" } : { material: "dense", form: "masonry", perforated: "none" };
  if (/ziegel|\bHLz\b|\bMz\b|klinker|poroton|unipor|thermopor/i.test(text))
    return { material: "dense", form: "masonry", perforated: /hochloch|\bHLz\b|planziegel|poroton|unipor|thermopor|wärmedämmziegel|waermedaemmziegel/i.test(text) ? "clay" : "none" };
  if (/betonstein|vollstein|vollblock|hohlblock|\bVn\b|\bVbn\b|\bHbn\b/i.test(text)) return { material: "dense", form: "masonry", perforated: /hohlblock|\bHbn\b|loch/i.test(text) ? "block" : "none" };
  if (/stahlbeton|ortbeton|beton|\bSTB\b|fertigteil|elementwand|\bC\d{2}\/\d{2}\b/i.test(text) || (!text.trim() && construction === "concrete")) return { material: "dense", form: "concrete", perforated: "none" };
  return { reason: "material_unknown" };
}

const de = (value: number, digits = 1) => value.toFixed(digits).replace(".", ",");
/** German basis text for the Nachweis: method, inputs and assumptions, no coefficients. */
export function catalogueBasis(result: Extract<MassiveWallRw, { status: "calculated" }>, input: MassiveWallInput) {
  const density = input.form === "masonry" ? `Wandrohdichte ${result.wallDensityKgM3} kg/m³ aus Rohdichteklasse ${de(input.densityKgM3! / 1000, 2)}` : `Rohdichte ${result.wallDensityKgM3} kg/m³`;
  const notes = [
    ...(result.assumptions.includes("mortar_unknown_lowest") ? ["Mörtelart unbekannt, ungünstigster Wert"] : []),
    ...(result.assumptions.includes("reinforced_concrete_density") ? ["Rechenwert Stahlbeton"] : []),
    ...(result.assumptions.includes("without_plaster") ? ["ohne Putz"] : []),
  ];
  return `${result.edition}, ${result.refs.join(", ")}: m' = ${de(input.thicknessCm! / 100, 3)} m × ${result.wallDensityKgM3} kg/m³ = ${de(result.massKgM2)} kg/m² (${density}; ${notes.join("; ")})`;
}

type Latest = { value: unknown; evidence: unknown[] };
async function wallInputs(d: AppDeps, modelId: string, wallIds: string[]) {
  const keys = ["construction", "material", "thickness", "bulkDensity"];
  const properties = await d.db.select({ id: buildingProperties.id, entityId: buildingProperties.entityId, key: buildingProperties.propertyKey }).from(buildingProperties)
    .where(and(eq(buildingProperties.modelId, modelId), eq(buildingProperties.tenantId, d.tenantId), inArray(buildingProperties.entityId, wallIds), inArray(buildingProperties.propertyKey, keys))) as any[];
  const values = new Map<string, Latest>();
  if (!properties.length) return values;
  const byId = new Map(properties.map(row => [row.id, row]));
  const versions = await d.db.select().from(buildingPropertyVersions).where(and(eq(buildingPropertyVersions.tenantId, d.tenantId), inArray(buildingPropertyVersions.propertyId, properties.map(row => row.id))))
    .orderBy(desc(buildingPropertyVersions.version)) as any[];
  for (const version of versions) {
    const property = byId.get(version.propertyId), key = `${property.entityId}:${property.key}`;
    if (values.has(key) || version.reviewStatus === "rejected" || version.value === null) continue;
    values.set(key, { value: version.value, evidence: Array.isArray(version.evidence) ? version.evidence : [] });
  }
  return values;
}

export type CatalogueWallResult = { wallId: string; wall: string; status: "suggested" | "skipped" | "unavailable"; rwDb: number | null; reason: string | null };

/** Suggests Rw for every exterior wall of the verification that has none yet. */
export async function suggestCatalogueValues(d: AppDeps, projectId: string, tx: any = d.db) {
  d.requirePermission("projects:write");
  const massiveWallRw = d.exteriorNoise?.massiveWallRw;
  if (!massiveWallRw) return { status: "unavailable" as const, reason: "catalogue_missing", walls: [] as CatalogueWallResult[], written: 0 };
  const proof = await readExteriorNoiseProof(d, projectId);
  if (!proof.available) return { status: "unavailable" as const, reason: proof.reason, walls: [] as CatalogueWallResult[], written: 0 };
  const modelRow = await modelForProject(d, projectId);
  if (!modelRow) return { status: "unavailable" as const, reason: "model_missing", walls: [] as CatalogueWallResult[], written: 0 };
  const modelId = modelRow.model.id;
  const walls = new Map(proof.rooms.flatMap(room => room.facades.filter(facade => !facade.rw).map(facade => [facade.wallId, facade.wallName] as const)));
  const inputs = await wallInputs(d, modelId, [...walls.keys()]);
  const results: CatalogueWallResult[] = [];
  const writes: Array<{ wallId: string; rw: number; basis: string; evidence: unknown[] }> = [];
  for (const [wallId, wall] of walls) {
    const value = (key: string) => inputs.get(`${wallId}:${key}`)?.value;
    const classified = classifyMassiveWall(typeof value("construction") === "string" ? value("construction") as string : null, typeof value("material") === "string" ? value("material") as string : null);
    if ("reason" in classified) { results.push({ wallId, wall, status: "unavailable", rwDb: null, reason: classified.reason }); continue; }
    const input: MassiveWallInput = { ...classified, thicknessCm: typeof value("thickness") === "number" ? value("thickness") as number : null,
      densityKgM3: typeof value("bulkDensity") === "number" ? value("bulkDensity") as number : null };
    const result = massiveWallRw(input);
    if (result.status !== "calculated") { results.push({ wallId, wall, status: "unavailable", rwDb: null, reason: result.reason }); continue; }
    // Cite the pages the wall's material, thickness and density were read from.
    const evidence = ["material", "thickness", "bulkDensity", "construction"].flatMap(key => inputs.get(`${wallId}:${key}`)?.evidence ?? [])
      .filter(item => buildingEvidenceSchema.safeParse(item).success)
      .filter((item, index, all) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(item)) === index).slice(0, 5);
    writes.push({ wallId, rw: result.rwDb, basis: catalogueBasis(result, input), evidence });
    results.push({ wallId, wall, status: "suggested", rwDb: result.rwDb, reason: null });
  }
  let written = 0;
  if (writes.length) {
    // Lock the model so concurrent edits queue behind the suggestions; the revision moves only when something was written.
    const [model] = await tx.select({ revision: buildingModels.revision }).from(buildingModels).where(and(eq(buildingModels.id, modelId), eq(buildingModels.tenantId, d.tenantId))).for("update");
    for (const item of writes) {
      const skipped = await writeSuggestion(tx, d, modelId, { entityType: "element", entityId: item.wallId, propertyKey: "soundReductionIndex", value: item.rw, unit: "dB", evidence: item.evidence });
      if (skipped) { const entry = results.find(result => result.wallId === item.wallId)!; entry.status = "skipped"; entry.reason = skipped; continue; }
      await writeSuggestion(tx, d, modelId, { entityType: "element", entityId: item.wallId, propertyKey: "soundReductionIndexBasis", value: item.basis, unit: null, evidence: item.evidence });
      written++;
    }
    if (written) {
      const revision = await touchRevision(tx, d, modelId, model.revision);
      await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId, revision, status: "draft", createdBy: d.actorId });
      await d.audit(tx, "projects.building.exterior_noise.catalogue_suggested", "building_model", modelId, { projectId, modelRevision: revision, written, packId: d.exteriorNoise?.packId ?? null });
      return { status: "suggested" as const, modelRevision: revision, written, walls: results };
    }
  }
  return { status: "unchanged" as const, modelRevision: modelRow.model.revision, written, walls: results };
}

export function createExteriorNoiseCatalogueRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  router.post("/projects/:projectId/exterior-noise/proof/catalogue", async (req, res, next) => {
    try {
      const d = getDeps(req);
      const projectId = z.string().uuid().parse(req.params.projectId);
      z.object({}).strict().parse(req.body ?? {});
      const result = await d.db.transaction((tx: any) => suggestCatalogueValues({ ...d, db: tx }, projectId, tx));
      res.json(ok(result));
    } catch (error) { next(error); }
  });
  return router;
}
