import { expect, test } from "bun:test";
import { readDevelopmentPlanNoise } from "./development-plan";

const festsetzungen = `Textliche Festsetzungen

6. Vorkehrungen zum Schutz vor schädlichen Umwelteinwirkungen (§ 9 Abs. 1 Nr. 24 BauGB)
6.1 In den mit LPB gekennzeichneten Bereichen sind die Außenbauteile schutzbedürftiger Räume entsprechend den Lärmpegelbereichen III bis V nach DIN 4109 (Ausgabe November 1989) auszubilden.
6.2 Schlafräume sind mit schallgedämmten Lüftungseinrichtungen auszustatten, sofern sie nicht zur lärmabgewandten Seite orientiert sind.

7. Dachbegrünung
Flachdächer sind zu begrünen.`;

test("a Bebauungsplan's noise requirements are read as stated, zones are not assigned", () => {
  const noise = readDevelopmentPlanNoise([{ page: 3, text: festsetzungen }]);
  expect(noise.noiseZones).toEqual(["III", "IV", "V"]);
  expect(noise.din4109).toEqual(["DIN 4109 (1989)"]);
  expect(noise.measures).toEqual(["schallgedämmte Lüftung", "Grundrissorientierung zur lärmabgewandten Seite"]);
  expect(noise.summary).toBe("Lärmpegelbereiche III, IV, V (Zuordnung zum Baufeld in der Planzeichnung prüfen) · schallgedämmte Lüftung · Grundrissorientierung zur lärmabgewandten Seite · verweist auf DIN 4109 (1989)");
  expect(noise.statements[0]).toEqual({ label: "Lärmpegelbereich III, IV, V", page: 3, quote: expect.stringMatching(/^6\.1 In den mit LPB gekennzeichneten Bereichen/) });
  // Unrelated sections (roof planting) are not quoted.
  expect(noise.statements.some(statement => statement.quote.includes("begrünen"))).toBe(false);
});

test("levels and required facade insulation are kept with their numbers", () => {
  const noise = readDevelopmentPlanNoise([{ page: 1, text: "Entlang der Hauptstraße beträgt der maßgebliche Außenlärmpegel 66 bis 70 dB(A). Für Aufenthaltsräume ist ein gesamtes bewertetes Bau-Schalldämm-Maß R'w,ges von mindestens 40 dB nachzuweisen; Grundlage ist DIN 4109-1:2018-01." }]);
  expect(noise.noiseZones).toEqual([]);
  expect(noise.externalLevels).toEqual(["66–70 dB(A)"]);
  expect(noise.facadeInsulation).toEqual(["R'w,ges ≥ 40 dB"]);
  expect(noise.din4109).toEqual(["DIN 4109 (2018)"]);
  expect(noise.summary).toBe("maßgeblicher Außenlärmpegel 66–70 dB(A) · R'w,ges ≥ 40 dB · verweist auf DIN 4109 (2018)");
});

test("one zone is stated plainly; a plan without noise text yields nothing", () => {
  expect(readDevelopmentPlanNoise([{ page: 2, text: "Für das Allgemeine Wohngebiet WA 2 gilt Lärmpegelbereich IV." }]).summary).toBe("Lärmpegelbereich IV");
  expect(readDevelopmentPlanNoise([{ page: 1, text: "Die Grundflächenzahl beträgt 0,4. Stellplätze sind in Tiefgaragen unterzubringen." }]).summary).toBeNull();
});
