import { Router, type Request } from "express";
import { z } from "zod";
import { ok, type AirborneResult, type ImpactOtherResult, type ImpactResult, type InteriorElementReason, type InteriorGap, type InteriorLimitation, type InteriorSoundProof, type ServiceResult, type StairResult, type TimberImpactResult } from "@richtfest/shared";
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
const doorGaps: Record<string, string> = { door_role: "wohin die Tür führt", door_rw: "Rw der Tür (Prüfzeugnis) oder Türblatt und Dichtungen", no_requirement: "keine Anforderung für diese Tür hinterlegt",
  criteria_not_applicable: "Rw der Tür (Prüfzeugnis); die Kriterien für Türblatt und Dichtungen reichen für diese Anforderung nicht" };
const reasons: Record<InteriorElementReason, string> = {
  construction_missing: "Konstruktion oder Material fehlt", material_unknown: "Material nicht eindeutig", multi_leaf: "mehrschaliger oder gedämmter Aufbau",
  thickness_missing: "Dicke fehlt", density_missing: "Rohdichte fehlt", density_class_out_of_range: "Rohdichteklasse außerhalb des Bauteilkatalogs",
  perforated_not_homogeneous: "Lochsteine nicht als homogen einstufbar", mass_out_of_range: "flächenbezogene Masse außerhalb des Bauteilkatalogs",
  catalogue_missing: "Bauteilkatalog nicht verfügbar", flanking_level_difference_missing: "Dn,f,w der leichten Wand fehlt",
  lightweight_separating: "Zeile im Bauteilkatalog für leichtes Trennbauteil fehlt", catalogue_row_unknown: "gewählte Katalogzeile unbekannt",
  timber_inputs_missing: "Holzbalkendecke: Untersicht, Wandbekleidung der Räume darunter oder Dämmung unter dem Estrich fehlt",
};
const constructions: Record<string, string> = { masonry: "Mauerwerk", concrete: "Beton", drywall: "Trockenbau", timber: "Holz", steel: "Stahl", other: "Sonstige" };
const edges: Record<string, string> = { start: "Anfang", end: "Ende", top: "Decke", bottom: "Boden" };
const gapText = (gap: InteriorGap) => gap.code === "element" ? `${gap.elementName}: ${reasons[gap.reason]}`
  : gap.code === "flanking_missing" ? `kein flankierendes Bauteil am ${edges[gap.edge] ?? gap.edge} im Gebäudemodell`
  : ({ clear_height: "lichte Raumhöhe", geometry: "Raumgeometrie", ceiling_missing: "Decke über den Räumen fehlt im Gebäudemodell", ceiling_role: "Art der Decke (Anforderung)",
    screed: "schwimmender Estrich (Art, flächenbezogene Masse, dynamische Steifigkeit)", no_requirement: "keine Anforderung für diese Bauteilart hinterlegt",
    room_use: "Nutzung des Empfangsraums", stair_case: "Ausführung der Treppe (Lauf oder Podest, Anbindung an die Treppenraumwand)",
    stair_wall: "Treppenraumwand zu einem schutzbedürftigen Raum (Rolle der Wand, Nutzung des Raums dahinter)", installation_kind: "Art der Anlage", installation_proof: "Nachweisweg (Musterinstallationswand oder Pegel)", installation_wall: "Installationswand",
    service_level: "LAF,max,n aus Messung oder Herstellernachweis" } as Record<string, string>)[gap.code] ?? gap.code;
const unsupported: Record<string, string> = {
  method_missing: "Rechenverfahren nicht verfügbar", mixed_flanking: "Stoß aus leichtem und massivem Flankenbauteil (nicht abgedeckt)", no_edges: "keine Flankenbauteile",
  invalid_geometry: "Geometrie unvollständig", slab_mass_out_of_range: "Deckenmasse außerhalb des Verfahrens", flanking_mass_out_of_range: "Masse der Flankenbauteile außerhalb des Verfahrens",
  no_massive_flanking: "keine massiven Flankenbauteile", screed_out_of_range: "Estrichkennwerte außerhalb des Verfahrens",
  wall_too_light: "Wand zu leicht für das Verfahren", case_missing: "Treppenausführung nicht im Bauteilkatalog", wall_mass_missing: "Masse der Treppenraumwand fehlt",
  no_requirement: "keine Anforderung hinterlegt",
};
const serviceFailures: Record<string, string> = {
  wall_too_light: "Installationswand leichter als die Musterinstallationswand", slab_too_light: "Rohdecke leichter als für die leichte Musterinstallationswand gefordert",
  borders_protected_room: "Installationswand grenzt an einen schutzbedürftigen Raum einer anderen Einheit", build_up_unconfirmed: "Aufbau der Ständerwand nicht als Musteraufbau bestätigt",
  conditions_unconfirmed: "Armaturen, Befestigung, Entkopplung und Herstellernachweise nicht bestätigt", not_sanitary: "nur Sanitärinstallationen sind über die Musterinstallationswand nachweisbar",
};
const stairCases: Record<string, string> = {
  landing_rigid: "Podest, fest mit einschaliger Treppenraumwand", run_rigid: "Lauf, fest mit einschaliger Treppenraumwand", run_separated: "Lauf, abgesetzt von einschaliger Treppenraumwand",
  landing_joint: "Podest, fest, mit Gebäudetrennfuge", run_separated_joint: "Lauf, abgesetzt, mit Gebäudetrennfuge", run_elastic_joint: "Lauf, abgesetzt, mit Gebäudetrennfuge, elastisch gelagert",
};
const limitationText: Record<InteriorLimitation, string> = {
  minimum_requirements_only: "Nachgewiesen werden die Mindestanforderungen nach DIN 4109-1; ein vereinbarter erhöhter Schallschutz ist nicht nachgewiesen.",
  junction_types: "Stoßstellen als starre T- oder Kreuzstöße aus dem Grundriss: Kreuzstoß, wo das Trennbauteil hinter dem Flankenbauteil in Flucht weiterläuft (Versatz in der Grenze des Bauteilkatalogs) oder die Wand im Nachbargeschoss weitergeht, bei Decken an Innenwänden. Eckstöße, elastische Zwischenschichten und Lochstein-Außenwände in Stumpfstoßtechnik sind nicht gesondert korrigiert. Flankenbauteile unterschiedlicher Masse beidseits des Trennbauteils mit ihrer mittleren flächenbezogenen Masse.",
  linings_one_side: "Einseitige Vorsatzschalen an Trennwänden sind auf der jeweils ungünstigeren Seite angesetzt; an flankierenden Innenwänden nur, wo sie verschlechtern.",
  doors_not_checked: "Türen und Wände mit Türen sind nicht nachgewiesen.",

  floor_like_ceiling: "Die Geschossdecke unter dem Geschoss ist nicht im Modell; sie wurde gleich der Decke darüber angenommen.",
  walls_above_like_below: "Decken: Wo im Geschoss darüber keine Wand auf einer Wand des Raums darunter steht (beim obersten Geschoss immer), wurde diese Wand nach oben fortgesetzt angenommen. Grundrisse übereinanderliegender Geschosse sind über den Gebäudeumriss ausgerichtet.",
  impact_hallways_only: "Trittschall in den Raum darunter; in andere Richtungen (nebenan, schräg darunter) nur vom Boden allgemein zugänglicher Flure in angrenzende Aufenthaltsräume.",
  timber_impact_vertical: "Holz- und Leichtbaudecken: Trittschall nur in den Raum direkt darunter; für andere Richtungen gibt es kein Rechenverfahren.",
  stairs_room_behind_wall: "Treppen: die Kennwerte gelten für den Raum direkt hinter der Treppenraumwand; ein fehlender Gehbelag ist als nicht vorhanden angesetzt.",
  services_execution: "Gebäudetechnik: Voraussetzung sind Ausführungsunterlagen mit den Schallschutznachweisen, eine benannte Bauleitung und deren Teilabnahme vor dem Schließen der Installation.",
};
const verdict = (meets: boolean) => meets ? "erfüllt" : "nicht erfüllt";
const liningText = (label: string, lining: NonNullable<Proof["elements"][number]["lining"]>) => lining.deltaRwDb !== null
  ? `${label}: f0 ${num(lining.f0Hz ?? 0, 0)} Hz, ΔRw ${dB(lining.deltaRwDb)} dB${lining.sides === "one" ? " (einseitig)" : ""}`
  : `${label}: nicht angerechnet (${lining.reason === "incomplete" ? "Angaben unvollständig" : lining.reason === "out_of_range" ? "f0 außerhalb der Tabelle" : "Verfahren nicht verfügbar"})`;

function airborneCell(result: AirborneResult | null, gaps: InteriorGap[]) {
  if (result?.status === "calculated") return { value: `${result.quantity} = ${dB(result.valueDb)} dB`, check: `${dB(result.valueDb - result.uncertaintyDb)} dB ${result.meets ? "≥" : "<"} ${dB(result.requiredDb)} dB`, verdict: verdict(result.meets) };
  if (result) return { value: "—", check: "—", verdict: unsupported[result.reason] ?? result.reason };
  return { value: "—", check: "—", verdict: gaps.length ? "Eingaben fehlen" : "—" };
}
function impactCell(result: ImpactResult | TimberImpactResult | ImpactOtherResult | StairResult | null) {
  if (result?.status === "calculated") return `L'n,w = ${dB(result.lnwPrimeDb)} dB; ${dB(result.lnwPrimeDb + result.uncertaintyDb)} dB ${result.meets ? "≤" : ">"} ${dB(result.maxDb)} dB: ${verdict(result.meets)}`;
  return result ? unsupported[result.reason] ?? result.reason : "—";
}
const pathTable = (result: Extract<AirborneResult, { status: "calculated" }>) => ["| Stoß | Weg | von → nach | Kij | ΔR Vorsatz | Rij |\n| --- | --- | --- | --- | --- | --- |",
  `| — | Dd | Trennbauteil | — | — | ${dB(result.rDdDb)} dB |`,
  ...result.paths.map(path => `| ${md(edges[path.edge] ?? path.edge)}${path.junction === "cross" ? " (Kreuzstoß)" : ""} | ${path.path} | ${md(`${path.from} → ${path.to}`)} | ${path.kijDb === null ? "—" : `${dB(path.kijDb)} dB${path.kijMinApplied ? " (Kij,min)" : ""}`} | ${path.liningDb ? `${dB(path.liningDb)} dB` : "—"} | ${dB(path.rDb)} dB |`)].join("\n");
function serviceCell(result: ServiceResult | null) {
  if (!result) return "Eingaben fehlen";
  if (result.status !== "calculated") return unsupported[result.reason] ?? result.reason;
  if (result.method === "level") return `${dB(result.valueDb)} dB ${result.meets ? "≤" : ">"} ${dB(result.maxDb)} dB: ${verdict(result.meets)}`;
  return result.meets ? `Musterinstallationswand (${result.wall === "massive" ? "massiv" : "leicht"}): erfüllt` : `nicht abgedeckt: ${result.failures.map(item => serviceFailures[item] ?? item).join("; ")}`;
}

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
  const calculated = [...proof.walls.map(check => check.result), ...proof.ceilings.flatMap(check => [check.airborne, check.impact]), ...proof.impacts.map(check => check.result),
    ...proof.stairs.map(check => check.result), ...proof.services.map(check => check.result)].filter(result => result?.status === "calculated");
  if (!calculated.length && !proof.doors.some(check => check.result)) throw conflict("No wall, ceiling or door has complete inputs yet");
  const storeyName = new Map(proof.storeys.map(storey => [storey.id, storey.name]));
  const blockers = [
    ...proof.walls.filter(check => check.gaps.length).map(check => `${check.wallName} (${check.rooms.map(room => room.name).join(" / ")}): es fehlt ${check.gaps.map(gapText).join("; ")}.`),
    ...proof.ceilings.filter(check => check.gaps.length).map(check => `${check.ceilingName} über ${check.room.name}: es fehlt ${check.gaps.map(gapText).join("; ")}.`),
    ...proof.doors.filter(check => check.gaps.length).map(check => `Tür ${check.name}${check.room ? ` zu ${check.room.name}` : ""}: es fehlt ${check.gaps.map(gap => doorGaps[gap] ?? gap).join("; ")}.`),
    ...proof.impacts.filter(check => check.gaps.length).map(check => `Trittschall ${check.source.name} → ${check.room.name}: es fehlt ${check.gaps.map(gapText).join("; ")}.`),
    ...proof.stairs.filter(check => check.gaps.length).map(check => `Treppe ${check.stair.name}${check.room ? ` → ${check.room.name}` : ""}: es fehlt ${check.gaps.map(gapText).join("; ")}.`),
    ...proof.services.filter(check => check.gaps.length).map(check => `Anlage ${check.name}: es fehlt ${check.gaps.map(gapText).join("; ")}.`),
    ...proof.storeys.filter(storey => !storey.clearHeight).map(storey => `${storey.name}: lichte Raumhöhe fehlt.`),
    ...proof.suggestions.map(item => `${item.entityLabel || "Gebäude"}: ${item.propertyKey} ${String(item.value)}${item.unit ? ` ${item.unit}` : ""} ist ein Vorschlag von Richtfest und noch nicht bestätigt.`),
  ];
  const uncalculated = [...proof.walls.filter(check => check.result?.status !== "calculated"), ...proof.ceilings.filter(check =>
    (check.requirement?.rwMinDb != null && check.airborne?.status !== "calculated") || (check.requirement?.lnwMaxDb != null && check.impact?.status !== "calculated")), ...proof.doors.filter(check => !check.result),
    ...proof.impacts.filter(check => check.result?.status !== "calculated"), ...proof.stairs.filter(check => check.result?.status !== "calculated"),
    // A reference wall that is not covered still needs a measured level.
    ...proof.services.filter(check => check.result?.status !== "calculated" || !check.result.meets && check.result.method === "reference_wall")];
  const complete = !blockers.length && !uncalculated.length;
  const title = complete ? "Schallschutznachweis · Innenbauteile" : "Schallschutznachweis · Innenbauteile · Teilstand";
  const editions = proof.editions;
  const elevated = proof.requirementLevel === "elevated";
  const level = proof.level && proof.level !== "statutory_minimum" && !elevated ? " Vereinbart ist ein erhöhter Schallschutz; nachgewiesen sind nur die Mindestanforderungen." : "";
  const versionIds = [...new Set(proof.storeys.map(storey => storey.sourceVersionId))];
  await sources(d, projectId, versionIds);
  const content = [
    `# ${title}`,
    `${complete ? "Entwurf" : "Teilstand"} aus dem Richtfest-Gebäudemodell: Luftschalldämmung der Trennwände, Decken und Wohnungseingangstüren sowie Trittschalldämmung der Decken nach ${md(editions?.method)}, Anforderungen nach ${md(editions?.requirements)} (${elevated ? "erhöhter Schallschutz" : "Mindestanforderungen"}), Bauteildaten nach ${md(editions?.catalogue)} und ${md(editions?.screeds)}. Sicherheitsbeiwerte nach dem vereinfachten Verfahren.${level} Fachliche Prüfung und Freigabe stehen aus.`,
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
        ...proof.doors.map(check => { const result = check.result;
          const shown = !result ? "—" : result.method === "declared" ? `${dB(result.valueDb - result.uncertaintyDb)} dB ${result.meets ? "≥" : "<"} ${dB(result.requiredDb)} dB (${md(result.refs.slice(1).join(", "))})`
            : `${result.criteria.map(item => `${item.part === "leaf" ? "Türblatt" : item.part === "rebate_seal" ? "Falzdichtung" : "Bodendichtung"} ${dB(item.valueDb)} ${item.meets ? "≥" : "<"} ${dB(item.requiredDb)} dB`).join(", ")} (${md(result.refs.slice(1).join(", "))})`;
          return `| ${md(storeyName.get(check.storeyId))} | ${md(check.name)} | ${md(check.wall?.name)} | ${md(check.room?.name)} | ${check.role ? roles[String(check.role.value)] ?? md(check.role.value) : "fehlt"} | ${check.requirement ? `Rw ≥ ${check.requirement.rwMinDb} dB (${md(check.requirement.ref)})` : "—"} | ${check.rw ? `${dB(check.rw.value)} dB${check.basis ? ` (${md(check.basis.value)})` : ""}` : result?.method === "criteria" ? "Kriterien Türblatt/Dichtungen" : "fehlt"} | ${shown} | ${result ? verdict(result.meets) : "Eingaben fehlen"} |`; })].join("\n")] : []),
    ...(proof.impacts.length ? ["## Trittschall in andere Richtungen",
      ["| Geschoss | von | nach | Lage | Decke | Anforderung | Ergebnis |\n| --- | --- | --- | --- | --- | --- | --- |",
        ...proof.impacts.map(check => `| ${md(storeyName.get(check.storeyId))} | ${md(check.source.name)} | ${md(check.room.name)} | ${check.position === "beside" ? "nebenan" : "schräg darunter"} | ${md(check.slab?.name)} | ${check.requirement ? `L'n,w ≤ ${check.requirement.lnwMaxDb} dB (${md(check.requirement.ref)})` : "—"} | ${check.result?.status === "calculated" ? `Ln,eq,0,w ${dB(check.result.lnEq0Db)} − ΔLw ${dB(check.result.deltaLwDb)} − K_T ${dB(check.result.kTDb)}; ${impactCell(check.result)}` : check.gaps.length ? "Eingaben fehlen" : impactCell(check.result)} |`)].join("\n")] : []),
    ...(proof.stairs.length ? ["## Treppen · Trittschall",
      ["| Geschoss | Treppe | Ausführung | Raum hinter der Treppenraumwand | Anforderung | Ergebnis |\n| --- | --- | --- | --- | --- | --- |",
        ...proof.stairs.map(check => `| ${md(storeyName.get(check.storeyId))} | ${md(check.stair.name)} | ${check.stairCase ? stairCases[String(check.stairCase.value)] ?? md(check.stairCase.value) : "fehlt"}${check.deltaLw ? `, Belag/Estrich ΔLw ${dB(check.deltaLw.value)} dB` : ""} | ${md(check.room?.name)} | ${check.requirement ? `L'n,w ≤ ${check.requirement.lnwMaxDb} dB (${md(check.requirement.ref)})` : "—"} | ${check.result?.status === "calculated" ? `${check.result.quantity} ${dB(check.result.tableDb)} dB${check.result.deltaLwDb !== null ? ` − ${dB(check.result.deltaLwDb)} dB` : ""} (${md(check.result.refs.slice(1).join(", "))}); ${impactCell(check.result)}` : check.gaps.length ? "Eingaben fehlen" : impactCell(check.result)} |`)].join("\n")] : []),
    ...(proof.services.length ? ["## Gebäudetechnische Anlagen",
      ["| Geschoss | Anlage | Raum | Installationswand | Art | Nachweis | Ergebnis |\n| --- | --- | --- | --- | --- | --- | --- |",
        ...proof.services.map(check => `| ${md(storeyName.get(check.storeyId))} | ${md(check.name)} | ${md(check.room?.name)} | ${md(check.wall?.name)}${check.borders.length ? ` (grenzt an ${md(check.borders.map(room => room.name).join(", "))})` : ""} | ${check.kind?.value === "sanitary" ? "Sanitär/Wasser" : check.kind?.value === "other" ? "sonstige Anlage" : "fehlt"} | ${check.proof?.value === "reference_wall" ? "Musterinstallationswand" : check.proof?.value === "level" ? `LAF,max,n${check.basis ? ` (${md(check.basis.value)})` : ""}${check.requirement ? `, zulässig ${check.requirement.maxDb} dB (${md(check.requirement.ref)})` : ""}` : "fehlt"} | ${check.gaps.length ? "Eingaben fehlen" : serviceCell(check.result)} |`)].join("\n")] : []),
    "## Bauteile",
    ["| Bauteil | Konstruktion | m' | Rw / Dn,f,w | Vorsatz / Estrich | Grundlage |\n| --- | --- | --- | --- | --- | --- |",
      ...proof.elements.map(element => `| ${md(element.name)} | ${element.construction ? constructions[element.construction] ?? md(element.construction) : "—"} | ${element.massKgM2 === null ? "—" : `${num(element.massKgM2, 1)} kg/m²`} | ${[element.rwDb !== null && `Rw = ${dB(element.rwDb)} dB`, element.dnfwDb !== null && `Dn,f,w = ${dB(element.dnfwDb)} dB`, element.lnwDb != null && `Ln,w = ${dB(element.lnwDb)} dB`].filter(Boolean).join(", ") || "—"} | ${[element.lining && liningText(element.componentType === "ceiling" ? "Unterdecke" : "Vorsatzschale", element.lining), element.screedLining && liningText("Estrich", element.screedLining)].filter(Boolean).join("; ") || "—"} | ${element.reason ? `fehlt: ${reasons[element.reason]}` : md(element.basis ?? "eingegeben")} |`)].join("\n"),
    "## Übertragungswege",
    ...proof.walls.flatMap(check => check.result?.status === "calculated" ? [`### ${md(check.wallName)} · ${md(check.rooms.map(room => room.name).join(" / "))}`, pathTable(check.result)] : []),
    ...proof.ceilings.flatMap(check => check.airborne?.status === "calculated" ? [`### ${md(check.ceilingName)} über ${md(check.room.name)}`, pathTable(check.airborne)] : []),
    ...proof.ceilings.flatMap(check => check.impact?.status === "calculated" && "k1Db" in check.impact ? [`### Trittschall ${md(check.ceilingName)} über ${md(check.room.name)}`,
      `Ln,w = ${dB(check.impact.lnwDb)} dB, K1 = ${dB(check.impact.k1Db)} dB, K2 = ${dB(check.impact.k2Db)} dB; L'n,w = ${dB(check.impact.lnwPrimeDb)} dB. Grundlage: ${md(check.impact.refs.join(", "))}.`] : []),
    ...proof.ceilings.flatMap(check => check.impact?.status === "calculated" && "lnEq0Db" in check.impact ? [`### Trittschall ${md(check.ceilingName)} über ${md(check.room.name)}`,
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
