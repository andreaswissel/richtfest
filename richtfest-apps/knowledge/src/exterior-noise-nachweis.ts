import { Router, type Request } from "express";
import { z } from "zod";
import { acousticDatasetSchema, ok, renderAcousticCalculationReceipts, type ExteriorNoiseProof, type ProofGap } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { conflict, createArtifact, sources } from "./workspace";

type Proof = Extract<ExteriorNoiseProof, { available: true }>;

const md = (value: unknown) => String(value ?? "—").replace(/[\\`*_{}<>#!|\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ");
const dB = (value: number) => value.toFixed(1).replace(".", ",");
const gapText: Record<ProofGap, string> = {
  room_kind: "Raumnutzung", floor_area: "Grundfläche", clear_height: "lichte Raumhöhe", facade_level: "Fassadenpegel", wall_rw: "Rw der Wand",
  wall_construction: "Wandkonstruktion", window_area: "Fensterfläche", window_rw: "Rw eines Fensters", openings_exceed_facade: "Öffnungen größer als die Fassade",
  surfaces_unconfirmed: "Vollständigkeit der Außenflächen nicht bestätigt", applicability: "Anwendbarkeit des Verfahrens", flanking: "Flankenübertragung", no_facade: "keine Außenfassade",
};
const sourceStatus: Record<string, string> = { calculated: "berechnet", imported: "aus Gutachten", missing_inputs: "Eingaben fehlen", no_geometry: "keine kartierte Achse", not_used: "nicht verwendet" };
const issues: Record<string, string> = {
  missing_daily_traffic: "Verkehrsstärke (DTV)", missing_speed_limit: "zulässige Geschwindigkeit", missing_rating_levels: "Beurteilungspegel Tag und Nacht",
  surface_not_defined_for_speed: "Deckschicht für diese Geschwindigkeit nicht definiert",
};
const notes: Record<string, string> = {
  standard_traffic: "stündliche Verkehrsstärke und Lkw-Anteile aus den Standardwerten der Straßenart", heavy_share_split: "Lkw-Anteil im Standardverhältnis aufgeteilt",
  reference_surface: "Referenzdeckschicht angenommen", flat_gradient: "keine Längsneigung angenommen", lanes_assumed: "zwei Fahrstreifen angenommen",
};
const defaults: Record<string, (value: number | string) => string> = {
  speedLimit: value => `${value} km/h angenommen (innerorts)`, laneWidth: value => `Fahrstreifenbreite ${value} m angenommen`, lanes: value => `${value} Fahrstreifen angenommen`,
};
const limitations: Record<string, string> = {
  free_propagation: "Freie Schallausbreitung: Abschirmung durch andere Gebäude und Wände ist nicht berücksichtigt (Pegel liegen dadurch höher).",
  flat_ground: "Ebenes Gelände; Geländehöhen sind nicht berücksichtigt.",
  no_reflections: "Reflexionen und Mehrfachreflexionen sind nicht berücksichtigt; zwischen geschlossenen Fassaden können die Pegel höher liegen.",
  no_junction_correction: "Keine Knotenpunktkorrektur für Ampeln oder Kreisverkehre.",
  storey_height_assumed: "Immissionsorte in Höhe der Geschossdecke mit angenommener Geschosshöhe von {height} m.",
  rail_imported_all_facades: "Schienen-Beurteilungspegel aus einem Gutachten gelten für jede Fassade.",
  turned_away_reduction: "Abgewandte Fassaden erhalten mindestens den Pegel der lautesten Fassade des Geschosses abzüglich der Minderung für offene Bebauung.",
};

/** The derivation of La behind the Nachweis: sources, traffic, assumptions, facade levels and limits. */
function noiseAnnex(proof: Proof) {
  const levels = proof.levels;
  const nameOf = new Map(levels.sources.map(source => [source.id, source.name]));
  const walls = new Set(proof.rooms.flatMap(room => room.facades.map(facade => facade.wallId)));
  const facades = levels.facades.filter(facade => walls.has(facade.wallId) && (facade.storey.id === proof.storey.id || facade.storey.id === null));
  return [
    "## Anlage: Ermittlung der maßgeblichen Außenlärmpegel",
    `Straßen-Beurteilungspegel nach ${md(levels.editions.rls19)}; maßgebliche Außenlärmpegel La nach ${md(levels.editions.din4109)}. Fassaden aus ${md(levels.placement.fileName)}, Seite ${levels.placement.page}; Planplatzierung ${levels.placement.alignmentStatus === "reviewed" ? "geprüft" : "ungeprüft"}.`,
    "### Schallquellen",
    ["| Quelle | Status | Verkehr Tag / Nacht | L'W Tag / Nacht | Eingaben und Annahmen |\n| --- | --- | --- | --- | --- |",
    ...levels.sources.map(source => `| ${md(source.name)} | ${sourceStatus[source.status] ?? source.status} | ${source.emission
      ? `${Math.round(source.emission.day.hourlyTraffic)} / ${Math.round(source.emission.night.hourlyTraffic)} Kfz/h, Lkw ${source.emission.day.truck1Pct + source.emission.day.truck2Pct} / ${source.emission.night.truck1Pct + source.emission.night.truck2Pct} %, ${source.emission.speedKmh.car} km/h` : "—"} | ${source.emission
      ? `${dB(source.emission.day.lineLevelDb)} / ${dB(source.emission.night.lineLevelDb)} dB` : "—"} | ${md([...source.issues.map(issue => `fehlt: ${issues[issue] ?? issue}`), ...source.notes.map(note => notes[note] ?? note),
        ...source.defaults.map(item => defaults[item.key]?.(item.value) ?? item.key)].join("; ") || "—")} |`)].join("\n"),
    "### Fassadenpegel",
    ["| Fassade | Lr Tag / Nacht je Quelle | La Tag | La Nacht | La Schlafräume | Grundlage |\n| --- | --- | --- | --- | --- | --- |",
    ...facades.map(facade => `| ${md(`${facade.compass} · ${facade.wallName}`)} | ${md(facade.sources.map(item => `${nameOf.get(item.sourceId) ?? "—"} ${dB(item.dayDb)} / ${dB(item.nightDb)}`).join("; ") || "—")} | ${facade.level ? dB(facade.level.dayDb) : "—"} | ${facade.level ? dB(facade.level.nightDb) : "—"} | ${facade.level ? dB(facade.level.sleepingDb) : "—"} | ${facade.basis === "turned_away" ? "abgewandt" : facade.basis === "calculated" ? "berechnet" : "keine Quelle"} |`)].join("\n"),
    "### Grenzen der Pegelermittlung",
    ...levels.limitations.map(item => `- ${(limitations[item] ?? item).replace("{height}", String(levels.storeyHeightM))}`),
  ].join("\n\n");
}

/**
 * A draft Schallschutznachweis Außenlärm from the building-model inputs: the
 * same saved calculation, report and PDF as the agent input review, created
 * without AI. Rooms with open inputs stay listed as blocked.
 */
export function exteriorNoiseNachweisRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  router.post("/projects/:projectId/exterior-noise-nachweis", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("knowledge:read");
      d.requirePermission("knowledge:write");
      const projectId = z.string().uuid().parse(req.params.projectId);
      if (!d.exteriorNoiseProof || !d.calculateAcoustics) throw conflict("Exterior noise verification is unavailable");
      const proof = await d.exteriorNoiseProof(projectId);
      if (!proof.available) throw conflict("Exterior noise verification inputs are unavailable for this project");
      if (!proof.calculation?.input.rooms.length) throw conflict("No room has complete inputs yet");
      const blockers = proof.rooms.filter(room => room.kind?.value !== "not_protected" && room.gaps.length)
        .map(room => `Raum ${room.label}: es fehlt ${room.gaps.map(gap => gapText[gap]).join(", ")}.`);
      const dataset = acousticDatasetSchema.parse({ version: 1,
        receipt: { ...d.calculateAcoustics(proof.calculation.input), receiptId: crypto.randomUUID() },
        blockers, basedOn: null });
      const complete = Boolean(dataset.receipt.batch?.complete) && !blockers.length;
      const title = complete ? "Schallschutznachweis · Außenlärm" : "Schallschutznachweis · Außenlärm · Teilstand";
      const placementVersion = proof.levels.placement.sourceVersionId;
      await sources(d, projectId, [placementVersion]);
      const content = [
        `# ${title}`,
        complete
          ? "Entwurf aus dem Richtfest-Gebäudemodell und den berechneten Fassadenpegeln. Alle schutzbedürftigen Räume des Plans sind berechnet; fachliche Prüfung und Freigabe stehen aus."
          : "Teilstand aus dem Richtfest-Gebäudemodell und den berechneten Fassadenpegeln. Räume mit offenen Eingaben sind nicht berechnet; fachliche Prüfung und Freigabe stehen aus.",
        renderAcousticCalculationReceipts([dataset.receipt], "de"),
        ...(blockers.length ? ["## Offene Eingaben", ...blockers.map(note => `- ${md(note)}`)] : []),
        noiseAnnex(proof),
        "## Freigabe",
        "Aufgestellt: ______________________ Datum: __________\n\nGeprüft: ______________________ Datum: __________",
      ].join("\n\n");
      const created = await d.db.transaction((tx: any) => createArtifact(d, tx, { projectId, title, type: "draft", content, sourceVersionIds: [placementVersion] }, undefined, dataset));
      res.status(201).json(ok({ artifact: created.artifact, revision: created.revision, complete }));
    } catch (error) { next(error); }
  });
  return router;
}
