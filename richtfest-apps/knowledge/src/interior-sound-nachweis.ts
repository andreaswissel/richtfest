import { Router, type Request } from "express";
import { z } from "zod";
import { ok, type AirborneResult, type ImpactResult, type InteriorElementReason, type InteriorGap, type InteriorLimitation, type InteriorSoundProof } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { conflict, createArtifact, sources } from "./workspace";

type Proof = Extract<InteriorSoundProof, { available: true }>;

const md = (value: unknown) => String(value ?? "—").replace(/[\\`*_{}<>#!|\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ");
const dB = (value: number) => value.toFixed(1).replace(".", ",");
const num = (value: number, digits = 2) => value.toFixed(digits).replace(".", ",");
const roles: Record<string, string> = {
  apartment_partition: "Wohnungstrennwand", corridor_partition: "Wand neben Hausflur", stairwell: "Treppenraumwand",
  apartment_separating: "Wohnungstrenndecke", over_common_space: "Decke über Keller, Hausflur oder Treppenraum", under_common_attic: "Decke unter allgemein nutzbarem Dachraum",
  under_bathroom: "Decke unter Bad/WC",
  to_dwelling_hallway: "vom Hausflur/Treppenraum in Flur oder Diele der Wohnung", to_habitable_room: "vom Hausflur/Treppenraum direkt in einen Aufenthaltsraum",
};
const doorGaps: Record<string, string> = { door_role: "wohin die Tür führt", door_rw: "Rw der Tür (Prüfzeugnis)", no_requirement: "keine Anforderung für diese Tür hinterlegt" };
const reasons: Record<InteriorElementReason, string> = {
  construction_missing: "Konstruktion oder Material fehlt", material_unknown: "Material nicht eindeutig", multi_leaf: "mehrschaliger oder gedämmter Aufbau",
  thickness_missing: "Dicke fehlt", density_missing: "Rohdichte fehlt", density_class_out_of_range: "Rohdichteklasse außerhalb des Bauteilkatalogs",
  perforated_not_homogeneous: "Lochsteine nicht als homogen einstufbar", mass_out_of_range: "flächenbezogene Masse außerhalb des Bauteilkatalogs",
  catalogue_missing: "Bauteilkatalog nicht verfügbar", flanking_level_difference_missing: "Dn,f,w der leichten Wand fehlt", lightweight_separating: "leichtes Trennbauteil (nicht abgedeckt)",
};
const constructions: Record<string, string> = { masonry: "Mauerwerk", concrete: "Beton", drywall: "Trockenbau", timber: "Holz", steel: "Stahl", other: "Sonstige" };
const edges: Record<string, string> = { start: "Anfang", end: "Ende", top: "Decke", bottom: "Boden" };
const gapText = (gap: InteriorGap) => gap.code === "element" ? `${gap.elementName}: ${reasons[gap.reason]}`
  : gap.code === "flanking_missing" ? `kein flankierendes Bauteil am ${edges[gap.edge] ?? gap.edge} im Gebäudemodell`
  : ({ clear_height: "lichte Raumhöhe", geometry: "Raumgeometrie", ceiling_missing: "Decke über den Räumen fehlt im Gebäudemodell", ceiling_role: "Art der Decke (Anforderung)",
    screed: "schwimmender Estrich (Art, flächenbezogene Masse, dynamische Steifigkeit)", no_requirement: "keine Anforderung für diese Bauteilart hinterlegt" } as Record<string, string>)[gap.code] ?? gap.code;
const unsupported: Record<string, string> = {
  method_missing: "Rechenverfahren nicht verfügbar", mixed_flanking: "Stoß aus leichtem und massivem Flankenbauteil (nicht abgedeckt)", no_edges: "keine Flankenbauteile",
  invalid_geometry: "Geometrie unvollständig", slab_mass_out_of_range: "Deckenmasse außerhalb des Verfahrens", flanking_mass_out_of_range: "Masse der Flankenbauteile außerhalb des Verfahrens",
  no_massive_flanking: "keine massiven Flankenbauteile", screed_out_of_range: "Estrichkennwerte außerhalb des Verfahrens",
};
const limitationText: Record<InteriorLimitation, string> = {
  minimum_requirements_only: "Nachgewiesen werden die Mindestanforderungen nach DIN 4109-1; ein vereinbarter erhöhter Schallschutz ist nicht nachgewiesen.",
  t_junctions: "Alle Stoßstellen als starre T-Stöße (Flankenbauteil durchlaufend); bei Kreuzstößen liegt das Ergebnis dadurch auf der sicheren Seite. Stoßstellen mit versetzten Bauteilen und Lochstein-Außenwände in Stumpfstoßtechnik sind nicht gesondert korrigiert.",
  without_linings: "Ohne Vorsatzschalen, Unterdecken und Putz; Flankenbauteile unterschiedlicher Masse beidseits des Trennbauteils mit ihrer mittleren flächenbezogenen Masse.",
  doors_not_checked: "Türen und Wände mit Türen sind nicht nachgewiesen.",

  floor_like_ceiling: "Die Geschossdecke unter dem Geschoss ist nicht im Modell; sie wurde gleich der Decke darüber angenommen.",
  walls_above_like_below: "Decken: Wo im Geschoss darüber keine Wand auf einer Wand des Raums darunter steht (beim obersten Geschoss immer), wurde diese Wand nach oben fortgesetzt angenommen. Grundrisse übereinanderliegender Geschosse sind über den Gebäudeumriss ausgerichtet.",
  screed_not_credited_airborne: "Decken: die Verbesserung der Luftschalldämmung durch den schwimmenden Estrich ist nicht angerechnet (auf der sicheren Seite).",
  impact_vertical_only: "Trittschall nur in den direkt darunterliegenden Raum; Übertragung in andere Richtungen ist nicht nachgewiesen.",
};
const verdict = (meets: boolean) => meets ? "erfüllt" : "nicht erfüllt";

function airborneCell(result: AirborneResult | null, gaps: InteriorGap[]) {
  if (result?.status === "calculated") return { value: `${result.quantity} = ${dB(result.valueDb)} dB`, check: `${dB(result.valueDb - result.uncertaintyDb)} dB ${result.meets ? "≥" : "<"} ${dB(result.requiredDb)} dB`, verdict: verdict(result.meets) };
  if (result) return { value: "—", check: "—", verdict: unsupported[result.reason] ?? result.reason };
  return { value: "—", check: "—", verdict: gaps.length ? "Eingaben fehlen" : "—" };
}
function impactCell(result: ImpactResult | null) {
  if (result?.status === "calculated") return `L'n,w = ${dB(result.lnwPrimeDb)} dB; ${dB(result.lnwPrimeDb + result.uncertaintyDb)} dB ${result.meets ? "≤" : ">"} ${dB(result.maxDb)} dB: ${verdict(result.meets)}`;
  return result ? unsupported[result.reason] ?? result.reason : "—";
}
const pathTable = (result: Extract<AirborneResult, { status: "calculated" }>) => ["| Stoß | Weg | von → nach | Kij | Rij |\n| --- | --- | --- | --- | --- |",
  `| — | Dd | Trennbauteil | — | ${dB(result.rDdDb)} dB |`,
  ...result.paths.map(path => `| ${md(edges[path.edge] ?? path.edge)} | ${path.path} | ${md(`${path.from} → ${path.to}`)} | ${path.kijDb === null ? "—" : `${dB(path.kijDb)} dB${path.kijMinApplied ? " (Kij,min)" : ""}`} | ${dB(path.rDb)} dB |`)].join("\n");

/**
 * A draft Schallschutznachweis for interior components (separating walls and
 * ceilings) from the building model, created without AI. Checks with open
 * inputs and suggestions nobody has confirmed are listed; the draft is then a
 * Teilstand. The planner checks and signs it.
 */
export async function createInteriorSoundNachweis(d: AppDeps, projectId: string, tx?: any, runId?: string) {
  if (!d.interiorSoundProof) throw conflict("Interior sound verification is unavailable");
  const proof = await d.interiorSoundProof(projectId);
  if (!proof.available) throw conflict("Interior sound verification inputs are unavailable for this project");
  const calculated = [...proof.walls.map(check => check.result), ...proof.ceilings.flatMap(check => [check.airborne, check.impact])].filter(result => result?.status === "calculated");
  if (!calculated.length && !proof.doors.some(check => check.result)) throw conflict("No wall, ceiling or door has complete inputs yet");
  const storeyName = new Map(proof.storeys.map(storey => [storey.id, storey.name]));
  const blockers = [
    ...proof.walls.filter(check => check.gaps.length).map(check => `${check.wallName} (${check.rooms.map(room => room.name).join(" / ")}): es fehlt ${check.gaps.map(gapText).join("; ")}.`),
    ...proof.ceilings.filter(check => check.gaps.length).map(check => `${check.ceilingName} über ${check.room.name}: es fehlt ${check.gaps.map(gapText).join("; ")}.`),
    ...proof.doors.filter(check => check.gaps.length).map(check => `Tür ${check.name}${check.room ? ` zu ${check.room.name}` : ""}: es fehlt ${check.gaps.map(gap => doorGaps[gap] ?? gap).join("; ")}.`),
    ...proof.storeys.filter(storey => !storey.clearHeight).map(storey => `${storey.name}: lichte Raumhöhe fehlt.`),
    ...proof.suggestions.map(item => `${item.entityLabel || "Gebäude"}: ${item.propertyKey} ${String(item.value)}${item.unit ? ` ${item.unit}` : ""} ist ein Vorschlag von Richtfest und noch nicht bestätigt.`),
  ];
  const uncalculated = [...proof.walls.filter(check => check.result?.status !== "calculated"), ...proof.ceilings.filter(check =>
    (check.requirement?.rwMinDb != null && check.airborne?.status !== "calculated") || (check.requirement?.lnwMaxDb != null && check.impact?.status !== "calculated")), ...proof.doors.filter(check => !check.result)];
  const complete = !blockers.length && !uncalculated.length;
  const title = complete ? "Schallschutznachweis · Innenbauteile" : "Schallschutznachweis · Innenbauteile · Teilstand";
  const editions = proof.editions;
  const level = proof.level && proof.level !== "statutory_minimum" ? " Vereinbart ist ein erhöhter Schallschutz; nachgewiesen sind nur die Mindestanforderungen." : "";
  const versionIds = [...new Set(proof.storeys.map(storey => storey.sourceVersionId))];
  await sources(d, projectId, versionIds);
  const content = [
    `# ${title}`,
    `${complete ? "Entwurf" : "Teilstand"} aus dem Richtfest-Gebäudemodell: Luftschalldämmung der Trennwände, Decken und Wohnungseingangstüren sowie Trittschalldämmung der Decken nach ${md(editions?.method)}, Anforderungen nach ${md(editions?.requirements)} (Mindestanforderungen), Bauteildaten nach ${md(editions?.catalogue)} und ${md(editions?.screeds)}. Sicherheitsbeiwerte nach dem vereinfachten Verfahren.${level} Fachliche Prüfung und Freigabe stehen aus.`,
    `Grundlage: ${proof.storeys.map(storey => `${md(storey.name)} aus ${md(storey.fileName)}, Seite ${storey.page}, lichte Raumhöhe ${storey.clearHeight ? `${num(storey.clearHeight.value)} m` : "fehlt"}`).join("; ")}.`,
    "## Trennwände · Luftschall",
    proof.walls.length ? ["| Geschoss | Wand | Art | Räume | Trennfläche | Anforderung | Rechenwert | Nachweis | Ergebnis |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...proof.walls.map(check => { const cell = airborneCell(check.result, check.gaps);
        return `| ${md(storeyName.get(check.storeyId))} | ${md(check.wallName)} | ${roles[check.role] ?? check.role} | ${md(check.rooms.map(room => room.name).join(" / "))} | ${check.areaM2 === null ? "—" : `${num(check.areaM2)} m²`} | ${check.requirement ? `R'w ≥ ${check.requirement.rwMinDb} dB (${md(check.requirement.ref)}${check.requirement.door ? `; Wand mit Tür ${md(check.requirement.door.name)}` : ""})` : "—"} | ${cell.value} | ${cell.check} | ${cell.verdict} |`; })].join("\n")
      : "Keine Trennwand mit Rolle Wohnungstrennwand, Wand neben Hausflur oder Treppenraumwand zwischen zwei Räumen im Modell.",
    "## Decken · Luft- und Trittschall",
    proof.ceilings.length ? ["| Geschoss | Decke | Art | Raum darunter | Fläche | Anforderung | Luftschall | Trittschall |\n| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...proof.ceilings.map(check => { const cell = airborneCell(check.airborne, check.gaps);
        return `| ${md(storeyName.get(check.storeyId))} | ${md(check.ceilingName)} | ${check.role ? roles[String(check.role.value)] ?? md(check.role.value) : "fehlt"} | ${md(check.room.name)} | ${check.areaM2 === null ? "—" : `${num(check.areaM2)} m²`} | ${check.requirement ? `${check.requirement.rwMinDb != null ? `R'w ≥ ${check.requirement.rwMinDb} dB` : ""}${check.requirement.rwMinDb != null && check.requirement.lnwMaxDb != null ? ", " : ""}${check.requirement.lnwMaxDb != null ? `L'n,w ≤ ${check.requirement.lnwMaxDb} dB` : ""} (${md(check.requirement.ref)})` : "—"} | ${cell.value === "—" ? cell.verdict : `${cell.value}; ${cell.check}: ${cell.verdict}`} | ${impactCell(check.impact)} |`; })].join("\n")
      : "Keine Decke mit Anforderung im Modell.",
    ...(proof.doors.length ? ["## Türen · Luftschall",
      ["| Geschoss | Tür | in Wand | führt in | Art | Anforderung | Rw (Prüfwert) | Nachweis | Ergebnis |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ...proof.doors.map(check => `| ${md(storeyName.get(check.storeyId))} | ${md(check.name)} | ${md(check.wall?.name)} | ${md(check.room?.name)} | ${check.role ? roles[String(check.role.value)] ?? md(check.role.value) : "fehlt"} | ${check.requirement ? `Rw ≥ ${check.requirement.rwMinDb} dB (${md(check.requirement.ref)})` : "—"} | ${check.rw ? `${dB(check.rw.value)} dB${check.basis ? ` (${md(check.basis.value)})` : ""}` : "fehlt"} | ${check.result ? `${dB(check.result.valueDb - check.result.uncertaintyDb)} dB ${check.result.meets ? "≥" : "<"} ${dB(check.result.requiredDb)} dB (${md(check.result.refs.slice(1).join(", "))})` : "—"} | ${check.result ? verdict(check.result.meets) : "Eingaben fehlen"} |`)].join("\n")] : []),
    "## Bauteile",
    ["| Bauteil | Konstruktion | m' | Rw / Dn,f,w | Grundlage |\n| --- | --- | --- | --- | --- |",
      ...proof.elements.map(element => `| ${md(element.name)} | ${element.construction ? constructions[element.construction] ?? md(element.construction) : "—"} | ${element.massKgM2 === null ? "—" : `${num(element.massKgM2, 1)} kg/m²`} | ${element.rwDb !== null ? `Rw = ${dB(element.rwDb)} dB` : element.dnfwDb !== null ? `Dn,f,w = ${dB(element.dnfwDb)} dB` : "—"} | ${element.reason ? `fehlt: ${reasons[element.reason]}` : md(element.basis ?? "eingegeben")} |`)].join("\n"),
    "## Übertragungswege",
    ...proof.walls.flatMap(check => check.result?.status === "calculated" ? [`### ${md(check.wallName)} · ${md(check.rooms.map(room => room.name).join(" / "))}`, pathTable(check.result)] : []),
    ...proof.ceilings.flatMap(check => check.airborne?.status === "calculated" ? [`### ${md(check.ceilingName)} über ${md(check.room.name)}`, pathTable(check.airborne)] : []),
    ...proof.ceilings.flatMap(check => check.impact?.status === "calculated" ? [`### Trittschall ${md(check.ceilingName)} über ${md(check.room.name)}`,
      `Ln,eq,0,w = ${dB(check.impact.lnEq0Db)} dB, ΔLw = ${dB(check.impact.deltaLwDb)} dB, K = ${dB(check.impact.kDb)} dB (mittlere Masse der massiven Flankenbauteile ${num(check.impact.flankingMeanKgM2, 1)} kg/m²${check.impact.flankingMassCapped ? ", auf die Obergrenze des Verfahrens begrenzt (auf der sicheren Seite)" : ""}); L'n,w = ${dB(check.impact.lnwPrimeDb)} dB. Gleichungen: ${md(check.impact.refs.join(", "))}.`] : []),
    "## Annahmen und Grenzen",
    ...proof.limitations.map(item => `- ${limitationText[item]}`),
    ...(blockers.length ? ["## Offene Eingaben", ...blockers.map(note => `- ${md(note)}`)] : []),
    "## Freigabe",
    "Aufgestellt: ______________________ Datum: __________\n\nGeprüft: ______________________ Datum: __________",
  ].join("\n\n");
  const write = (inner: any) => createArtifact(d, inner, { projectId, title, type: "draft", content, sourceVersionIds: versionIds }, runId);
  const created = tx ? await write(tx) : await d.db.transaction(write);
  return { artifact: created.artifact, revision: created.revision, complete, openItems: blockers.length + uncalculated.length };
}

export function interiorSoundNachweisRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  router.post("/projects/:projectId/interior-sound-nachweis", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("knowledge:read");
      d.requirePermission("knowledge:write");
      const projectId = z.string().uuid().parse(req.params.projectId);
      res.status(201).json(ok(await createInteriorSoundNachweis(d, projectId)));
    } catch (error) { next(error); }
  });
  return router;
}
