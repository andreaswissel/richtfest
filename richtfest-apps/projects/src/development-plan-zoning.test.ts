import { expect, test } from "bun:test";
import { readDevelopmentPlanZoning } from "./development-plan";

const festsetzungen = `Textliche Festsetzungen

1. Art der baulichen Nutzung (§ 9 Abs. 1 Nr. 1 BauGB i. V. m. §§ 1 bis 15 BauNVO)
1.1 Die Baugebiete WA 1 und WA 2 werden als Allgemeines Wohngebiet gemäß § 4 BauNVO festgesetzt.
1.2 Das Baugebiet MI wird als Mischgebiet gemäß § 6 BauNVO festgesetzt.

2. Maß der baulichen Nutzung (§ 9 Abs. 1 Nr. 1 BauGB i. V. m. §§ 16 bis 21a BauNVO)
2.1 Die Grundflächenzahl (GRZ) beträgt im WA 1 0,4 und im WA 2 0,35.
2.2 Die zulässige Grundfläche darf durch die Grundflächen von Tiefgaragen bis zu einer GRZ von 0,8 überschritten werden.
2.3 Die Geschossflächenzahl (GFZ) wird auf 1,2 festgesetzt.
2.4 Es sind höchstens drei Vollgeschosse zulässig.
2.5 Die maximale Gebäudehöhe beträgt 12,50 m über dem Bezugspunkt; die Traufhöhe darf max. 9,0 m betragen.

3. Bauweise (§ 9 Abs. 1 Nr. 2 BauGB i. V. m. § 22 BauNVO)
3.1 Es gilt die offene Bauweise; zulässig sind nur Einzel- und Doppelhäuser.

4. Dachbegrünung
Flachdächer sind zu begrünen.`;

test("Art und Maß der baulichen Nutzung are read as stated, with the Baugebiet each value names", () => {
  const zoning = readDevelopmentPlanZoning([{ page: 4, text: festsetzungen }]);
  expect(zoning.areaTypes).toEqual(["WA 1", "WA 2", "MI"]);
  expect(zoning.values).toEqual({
    bebauungsplanAreaType: "WA 1, WA 2, MI",
    bebauungsplanGrz: "0,4 (WA 1) · 0,35 (WA 2) · bis 0,8 bei Überschreitung nach § 19 Abs. 4 BauNVO (Zuordnung zum Baufeld in der Planzeichnung prüfen)",
    bebauungsplanGfz: "1,2",
    bebauungsplanStoreys: "höchstens III",
    bebauungsplanHeight: "Gebäudehöhe max. 12,50 m über dem Bezugspunkt · Traufhöhe max. 9,0 m",
    bebauungsplanBauweise: "offene Bauweise · nur Einzel- und Doppelhäuser",
  });
  // Every value quotes its sentence; paragraph numbers (§ 19, Nr. 1) are never values.
  expect(zoning.statements.find(statement => statement.key === "bebauungsplanGfz")).toEqual({ key: "bebauungsplanGfz", label: "GFZ 1,2", page: 4, quote: "2.3 Die Geschossflächenzahl (GFZ) wird auf 1,2 festgesetzt." });
  expect(zoning.statements.some(statement => statement.quote.includes("begrünen"))).toBe(false);
});

test("Nutzungsschablone notation and Roman storey counts; mentions and Planzeichnung-only plans yield nothing", () => {
  const zoning = readDevelopmentPlanZoning([{ page: 1, text: "Zahl der Vollgeschosse: II (zwingend). Im urbanen Gebiet MU sind Gebäudehöhen bis 21,0 m ü. NHN zulässig." }]);
  expect(zoning.values).toEqual({ bebauungsplanAreaType: "MU", bebauungsplanStoreys: "zwingend II", bebauungsplanHeight: "Gebäudehöhe max. 21,0 m ü. NHN (MU)" });
  // A noise clause naming an area does not state its type; "kein Vollgeschoss" is not a count.
  expect(readDevelopmentPlanZoning([{ page: 2, text: "Im WA 2 gilt Lärmpegelbereich IV. Das Staffelgeschoss darf kein Vollgeschoss sein." }]).values).toEqual({});
  expect(readDevelopmentPlanZoning([{ page: 1, text: "Es gelten die Eintragungen der Planzeichnung." }]).statements).toEqual([]);
});

test("mandatory qualifiers after the count are preserved, not turned into a maximum", () => {
  for (const qualifier of ["zwingend", "mindestens"]) {
    const text = `Es sind zwei Vollgeschosse ${qualifier} vorgeschrieben.`;
    const result = readDevelopmentPlanZoning([{ page: 2, text }]);
    expect(result.values.bebauungsplanStoreys).toBe(`${qualifier} II`);
    expect(result.statements[0]?.quote).toBe(text);
  }
});

test("decimal points and distinct absolute and relative height datums survive extraction", () => {
  for (const datum of ["ü. NN", "ü. NHN", "über dem Bezugspunkt", "über der Straßenoberkante"]) {
    const text = `Die maximale Gebäudehöhe beträgt 12.50 m ${datum}.`;
    const result = readDevelopmentPlanZoning([{ page: 3, text }]);
    expect(result.values.bebauungsplanHeight).toBe(`Gebäudehöhe max. 12.50 m ${datum}`);
    expect(result.statements[0]?.quote).toBe(text);
  }
});

test("postposed zones bind to their own GRZ/GFZ, not the previous zone", () => {
  for (const [metric, key] of [["GRZ", "bebauungsplanGrz"], ["GFZ", "bebauungsplanGfz"]] as const) {
    const text = `${metric} beträgt 0,4 im WA1 und 0,6 im WA2.`;
    const result = readDevelopmentPlanZoning([{ page: 1, text }]);
    expect(result.values[key]).toBe("0,4 (WA 1) · 0,6 (WA 2)");
    expect(result.statements.every(statement => statement.quote === text)).toBe(true);
  }
});
